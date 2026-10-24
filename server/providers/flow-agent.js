import { StudioError } from "../store.js";
import { openFlowProject } from "./flow-project.js";
import { prepareFlowAgentSettings } from "./flow-agent-settings.js";

function unavailable(message) {
  return new StudioError(message, "PROVIDER_SETTING_UNAVAILABLE");
}

function normalize(value) {
  return String(value || "")
    .replace(/[–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function countLabel(kind, count) {
  return kind === "video" ? `${count} video` : `${count} image`;
}

function exactModel(text, model) {
  const expected = normalize(model);
  const variants = [expected, expected.replace("veo 3.1 ", "veo 3.1 - ")];
  return variants.some((value) => normalize(text).includes(value));
}

function proposalMatches(text, task) {
  const normalized = normalize(text);
  if (!normalized.includes("generation proposal") || !normalized.includes("please confirm")) return false;
  if (!exactModel(text, task.model)) return false;
  if (!normalized.includes(`${task.duration} seconds`) && !normalized.includes(`${task.duration} giây`)) return false;
  if (!text.includes(task.ratio)) return false;
  return normalized.includes(`quantity: 1 ${task.kind}`);
}

function permissionMatches(text, task) {
  const normalized = normalize(text);
  if (!normalized.includes("would you like me to kick off")) return false;
  if (!normalized.includes(`1 ${task.kind}`)) return false;
  return normalized.includes("costing") && normalized.includes("credits");
}
async function panelText(page) {
  return page.locator("flow-agent-panel:visible").innerText({ timeout: 5000 });
}

async function waitFor(page, check, message, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await panelText(page);
    if (check(text)) return text;
    if (/your data|privacy|terms of service|i agree/i.test(text)) {
      throw new StudioError(
        "Flow đang yêu cầu xử lý điều khoản trong cửa sổ tài khoản. Chưa gửi bước tiếp theo.",
        "PROVIDER_NOT_READY",
      );
    }
    await page.waitForTimeout(300);
  }
  throw unavailable(message);
}

async function attachReferences(page, files) {
  if (!files.length) return;
  const panel = page.locator("flow-agent-panel:visible");
  const add = panel.getByRole("button", { name: "Add ingredients to the prompt box", exact: true });
  if (await add.count() !== 1) throw unavailable("nút thêm ảnh tham chiếu");
  const chooser = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
  await add.click({ timeout: 10000 });
  const upload = page.getByRole("menuitem", { name: "Upload", exact: true });
  if (await upload.count() !== 1) throw unavailable("nút tải ảnh tham chiếu");
  await upload.click({ timeout: 8000 });
  const fileChooser = await chooser;
  if (fileChooser) await fileChooser.setFiles(files);
  else {
    const input = page.locator('input[type="file"]:visible, input[type="file"]');
    if (await input.count() !== 1) throw unavailable("ô tải ảnh tham chiếu");
    await input.setInputFiles(files);
  }
  const names = files.map((file) => file.split(/[\\/]/).at(-1));
  await waitFor(page, (text) => names.every((name) => text.includes(name)), "ảnh tham chiếu chưa tải xong", 120000);
}

export async function prepareFlowAgent(page, task, files = []) {
  if (!["text", "reference"].includes(task.mode)) {
    throw unavailable("Flow Agent chưa xác minh thao tác khung đầu/cuối hoặc kéo dài video. Chưa tải tệp và chưa gửi.");
  }
  if (task.mode === "text" && files.length) throw unavailable("chế độ văn bản không nhận ảnh tham chiếu");
  if (task.mode === "reference" && !files.length) throw unavailable("chế độ ảnh tham chiếu cần tệp ảnh");
  if (await page.locator("flow-agent-panel:visible").count() !== 1) await openFlowProject(page);
  const settings = await prepareFlowAgentSettings(page, task);
  await attachReferences(page, files);
  await settings.composer.fill(task.prompt);
  if ((await settings.composer.innerText()) !== task.prompt) throw unavailable("prompt Flow");
  if (!(await settings.send.isVisible()) || !(await settings.send.isEnabled())) throw unavailable("nút gửi Flow");
  return settings;
}

export async function runFlowAgent(page, task, prepared, { beforeAction = async () => {}, log = () => {} } = {}) {
  const { composer, send } = prepared;
  await beforeAction("planning");
  await send.click({ timeout: 15000 });
  log("Đã gửi yêu cầu lập đề xuất Flow. Chưa tính bước tạo có phí.");
  const proposal = await waitFor(page, (text) => proposalMatches(text, task), "Flow chưa hiển thị đề xuất đúng thông số");
  await composer.fill(`Yes, proceed with exactly this one ${countLabel(task.kind, 1)}: ${task.model}, ${task.duration} seconds, ${task.ratio}, quantity 1, using the proposed prompt.`);
  await beforeAction("confirmation");
  await send.click({ timeout: 15000 });
  log("Đã xác nhận đề xuất Flow một lần; đang chờ quyền tạo.");
  const permission = await waitFor(page, (text) => permissionMatches(text, task), "Flow chưa hiển thị quyền xác nhận tạo đúng thông số");
  const panel = page.locator("flow-agent-panel:visible");
  const approve = panel.getByRole("radio", { name: "Approve", exact: true });
  if (await approve.count() !== 1 || await approve.getAttribute("aria-disabled") === "true") throw unavailable("nút Approve Flow");
  await beforeAction("approval");
  await approve.click({ timeout: 15000 });
  log("Đã bấm Approve Flow một lần; đang chờ media.");
  await waitFor(page, (text) => /generation has started|scheduled|queued|in progress/i.test(text), "Flow chưa xác nhận đã nhận tác vụ");
  return { proposal, permission };
}

