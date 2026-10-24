import { StudioError } from "../store.js";

const layout = [
  ["16:9", "4:3", "1:1", "3:4", "9:16"],
  ["x1", "x2", "x3", "x4"],
  ["16:9", "9:16"],
  ["x1", "x2", "x3", "x4"],
];

const normalize = (value) => String(value || "")
  .replace(/🍌/gu, "")
  .replace(/[–—-]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/\s/g, "")
  .toLowerCase();

function unavailable(setting) {
  return new StudioError(
    `Không xác nhận được ${setting} trong cài đặt Flow. Chưa gửi yêu cầu tạo.`,
    "PROVIDER_SETTING_UNAVAILABLE",
  );
}

async function noConsentDialog(page) {
  for (const dialog of await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').all()) {
    const text = await dialog.innerText();
    if (/\b(?:I agree|accept terms|consent|your data|privacy|terms of service)\b|tôi đồng ý|điều khoản|quyền riêng tư/i.test(text)) {
      throw new StudioError(
        "Flow đang yêu cầu bạn xử lý hộp thoại đồng ý trong cửa sổ tài khoản. Chưa gửi yêu cầu tạo.",
        "PROVIDER_NOT_READY",
      );
    }
  }
}

async function only(locator, setting) {
  const visible = locator.filter({ visible: true });
  if (await visible.count() !== 1) throw unavailable(setting);
  return visible;
}

async function label(locator) {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true);
    for (const icon of copy.querySelectorAll('[aria-hidden="true"], mat-icon')) icon.remove();
    return copy.textContent || "";
  });
}

async function checked(locator) {
  return locator.evaluate((element) => element.checked === true || element.getAttribute("aria-checked") === "true");
}

async function verifyEventually(page, check, setting) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await noConsentDialog(page);
    if (await check()) return;
    await page.waitForTimeout(100);
  }
  throw unavailable(setting);
}

async function chooseRadio(page, group, name, setting) {
  const option = await only(group.getByRole("radio", { name, exact: true }), setting);
  if (!(await checked(option))) {
    await noConsentDialog(page);
    await option.click({ timeout: 5000 });
  }
  await verifyEventually(page, () => checked(option), setting);
  return option;
}

async function verifyLayout(settings) {
  const groups = settings.locator("mat-button-toggle-group");
  if (await groups.count() !== layout.length) throw unavailable("cấu trúc nhóm tùy chọn");
  for (let index = 0; index < layout.length; index += 1) {
    const radios = groups.nth(index).getByRole("radio");
    if (await radios.count() !== layout[index].length) throw unavailable("cấu trúc nhóm tùy chọn");
    for (const name of layout[index]) {
      await only(groups.nth(index).getByRole("radio", { name, exact: true }), "cấu trúc nhóm tùy chọn");
    }
  }
  return groups;
}

async function chooseModel(page, settings, kind, model) {
  const name = `${kind === "video" ? "Video" : "Image"} generation default model`;
  const trigger = await only(settings.getByRole("button", { name, exact: true }), "model");
  const matches = async () => normalize(await label(trigger)) === normalize(model);
  if (!(await matches())) {
    await noConsentDialog(page);
    await trigger.click({ timeout: 5000 });
    await page.getByRole("menu").filter({ visible: true }).waitFor({ timeout: 5000 });
    const menu = await only(page.getByRole("menu"), "menu model");
    const choices = [];
    for (const item of await menu.getByRole("menuitem").all()) {
      if (await item.isVisible() && normalize(await label(item)) === normalize(model)) choices.push(item);
    }
    if (choices.length !== 1) throw unavailable("model được yêu cầu");
    await noConsentDialog(page);
    await choices[0].click({ timeout: 5000 });
    // Angular leaves an overlay backdrop briefly while closing the menu.
    await menu.waitFor({ state: "hidden", timeout: 5000 });
    await page.locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing").waitFor({ state: "hidden", timeout: 5000 });
  }
  await verifyEventually(page, matches, "model được yêu cầu");
  return matches;
}

/**
 * Configure an already-open Flow project. This function neither fills a prompt
 * nor submits a planning/generation request. Duration and the actual generated
 * kind/mode must be verified by the caller against the subsequent proposal.
 */
export async function prepareFlowAgentSettings(page, task) {
  if (!["text", "reference"].includes(task.mode)) throw unavailable("chế độ khung đầu/cuối hoặc kéo dài chưa được hỗ trợ");
  if (!["image", "video"].includes(task.kind)) throw unavailable("loại nội dung");
  const offset = task.kind === "video" ? 2 : 0;
  if (!layout[offset].includes(task.ratio)) throw unavailable("tỷ lệ khung hình");
  if (typeof task.model !== "string" || !task.model.trim()) throw unavailable("model");

  try {
    await noConsentDialog(page);
    let settings = page.locator("flow-settings-view:visible");
    if (await settings.count() === 0) {
      const panel = await only(page.locator("flow-agent-panel"), "bảng tạo bằng trợ lý");
      const open = await only(panel.getByRole("button", { name: "Settings", exact: true }), "nút cài đặt trợ lý");
      await open.click({ timeout: 5000 });
      await settings.waitFor({ timeout: 5000 });
    }
    settings = await only(settings, "bảng cài đặt trợ lý");
    await noConsentDialog(page);
    const groups = await verifyLayout(settings);
    const always = await only(settings.getByRole("radio", { name: /^Always(?:\s|$)/i }), "luôn xác nhận trước khi tạo");
    if (!(await checked(always))) await always.click({ timeout: 5000 });
    await verifyEventually(page, () => checked(always), "luôn xác nhận trước khi tạo");
    const modelMatches = await chooseModel(page, settings, task.kind, task.model);
    const ratio = await chooseRadio(page, groups.nth(offset), task.ratio, "tỷ lệ khung hình");
    const count = await chooseRadio(page, groups.nth(offset + 1), "x1", "một kết quả");
    // A model/count change can reset earlier settings. Verify the final state.
    if (!(await checked(always))) throw unavailable("luôn xác nhận trước khi tạo");
    if (!(await modelMatches())) throw unavailable("model được yêu cầu");
    if (!(await checked(ratio))) throw unavailable("tỷ lệ khung hình");
    if (!(await checked(count))) throw unavailable("một kết quả");
    await noConsentDialog(page);
    const save = await only(settings.getByRole("button", { name: "Save", exact: true }), "nút lưu cài đặt");
    await save.click({ timeout: 5000 });
    await settings.waitFor({ state: "hidden", timeout: 5000 });
    await noConsentDialog(page);
    const panel = await only(page.locator("flow-agent-panel"), "bảng tạo bằng trợ lý");
    const composer = panel.locator('div.ProseMirror[contenteditable="true"]');
    await composer.waitFor({ state: "visible", timeout: 5000 });
    const send = await only(panel.getByRole("button", { name: "Start generation", exact: true }), "nút gửi yêu cầu");
    return { composer: await only(composer, "ô nhập yêu cầu"), send };
  } catch (error) {
    if (error instanceof StudioError) throw error;
    // Do not expose page contents or browser URLs through low-level errors.
    throw unavailable("giao diện cài đặt trợ lý");
  }
}
