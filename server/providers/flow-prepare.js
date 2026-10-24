import path from "node:path";
import { StudioError } from "../store.js";
import { openFlowProject } from "./flow-project.js";

const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[–—-]/g, " ").replace(/\s+/g, " ");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (labels) => new RegExp(`^(?:${labels.map(escape).join("|")})$`, "i");
const unavailable = (name) => new StudioError(
  `Không xác nhận được tùy chọn ${name} trong Google Flow. Kiểm tra cửa sổ tài khoản; chưa gửi yêu cầu tạo.`,
  "PROVIDER_SETTING_UNAVAILABLE",
);

async function visibleItems(locator) {
  const items = [];
  for (const item of await locator.all()) {
    if (await item.isVisible()) items.push(item);
  }
  return items;
}

async function noConsentDialog(page) {
  const dialogs = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible');
  for (const dialog of await dialogs.all()) {
    const text = await dialog.innerText();
    if (/\b(?:I agree|accept terms|consent|your data|privacy|terms of service)\b|tôi đồng ý|điều khoản|quyền riêng tư/i.test(text)) {
      throw new StudioError(
        "Flow đang yêu cầu bạn xem và xử lý hộp thoại đồng ý trong cửa sổ tài khoản; chưa gửi yêu cầu tạo.",
        "PROVIDER_NOT_READY",
      );
    }
  }
}

async function labelsOf(locator) {
  return locator.evaluate((element) => [
    element.innerText || element.textContent || "",
    element.getAttribute("aria-label") || "",
    element.getAttribute("title") || "",
  ]);
}

async function isSelected(locator) {
  return locator.evaluate((element) => {
    if (element.tagName === "OPTION") return element.selected;
    return ["aria-checked", "aria-selected", "aria-pressed"].some((name) => element.getAttribute(name) === "true") ||
      ["checked", "active", "on"].includes(element.getAttribute("data-state")) ||
      element.classList.contains("agent-mode-chip-checked") ||
      (element.tagName === "INPUT" && element.checked);
  });
}

function options(page, field) {
  const name = exact(field.labels);
  return page.getByRole("option", { name })
    .or(page.getByRole("radio", { name }))
    .or(page.getByRole("tab", { name }))
    .or(page.getByRole("menuitemradio", { name }))
    .or(page.getByRole("button", { name }));
}

function triggers(page, field) {
  const named = page.getByRole("combobox", { name: field.name })
    .or(page.getByRole("button", { name: field.name }));
  // Current model/mode labels often replace the generic field name. Only a
  // genuine popup trigger qualifies: a menu option with the same text does not.
  const current = page.getByRole("button", { name: field.current || field.name })
    .and(page.locator('[aria-haspopup], [aria-expanded]'));
  return named.or(current);
}

function matchesLabel(values, field) {
  return values.some((value) => field.labels.some((label) => {
    const actual = normalize(value);
    const wanted = normalize(label);
    return actual === wanted || actual === `${normalize(field.label)}: ${wanted}`;
  }));
}

async function selected(page, field) {
  for (const trigger of await visibleItems(triggers(page, field))) {
    const native = await trigger.evaluate((element) => element.tagName === "SELECT");
    if (native) {
      const labels = await trigger.locator("option:checked").allTextContents();
      if (matchesLabel(labels, field)) return true;
    } else if (matchesLabel(await labelsOf(trigger), field)) {
      return true;
    }
  }
  // Numeric values are meaningful only inside their named setting. A selected
  // scene numbered "1" elsewhere on the page cannot prove output count.
  if (field.numeric) {
    const groups = page.getByRole("radiogroup", { name: field.name })
      .or(page.getByRole("group", { name: field.name }));
    for (const group of await visibleItems(groups)) {
      for (const option of await visibleItems(options(group, field))) {
        if (await isSelected(option)) return true;
      }
    }
    return false;
  }
  for (const option of await visibleItems(options(page, field))) {
    if (await isSelected(option)) return true;
  }
  return false;
}

async function chooseVerified(page, field, openSettings) {
  if (await selected(page, field)) return;
  let controls = await visibleItems(triggers(page, field));
  let choices = await visibleItems(options(page, field));
  if (!controls.length && !choices.length) {
    await openSettings();
    controls = await visibleItems(triggers(page, field));
    choices = await visibleItems(options(page, field));
  }
  if (controls.length > 1) throw unavailable(field.label);
  if (controls.length === 1) {
    const control = controls[0];
    if (await control.evaluate((element) => element.tagName === "SELECT")) {
      const available = await control.locator("option").evaluateAll((elements) => elements.map((element) => ({ value: element.value, label: element.label })));
      const matching = available.filter((option) => matchesLabel([option.label], field));
      if (matching.length !== 1) throw unavailable(field.label);
      await control.selectOption(matching[0].value);
    } else {
      if (await control.getAttribute("aria-expanded") !== "true") await control.click();
      choices = await visibleItems(options(page, field));
      // The trigger itself can share its label with the current menu item.
      const menuChoices = [];
      for (const choice of choices) {
        if (await choice.evaluate((element) => !element.hasAttribute("aria-haspopup") && !element.hasAttribute("aria-expanded"))) menuChoices.push(choice);
      }
      if (menuChoices.length !== 1) throw unavailable(field.label);
      await menuChoices[0].click();
    }
  } else {
    if (choices.length !== 1) throw unavailable(field.label);
    await choices[0].click();
  }
  // Read back after the event/render cycle. Never infer success from a click.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await noConsentDialog(page);
    if (await selected(page, field)) return;
    await page.waitForTimeout(100);
  }
  throw unavailable(field.label);
}

async function attachReferences(page, files) {
  const panel = page.locator("flow-agent-panel:visible");
  if (await panel.count() !== 1) throw unavailable("vùng ảnh tham chiếu");
  const uploads = panel.locator('input[type="file"][accept*="image"]');
  if (await uploads.count() !== 1) throw unavailable("ô tải ảnh tham chiếu");
  const input = uploads.first();
  if (files.length > 1 && await input.getAttribute("multiple") === null) throw unavailable("nhiều ảnh tham chiếu");
  await input.setInputFiles(files);
  const names = files.map((file) => path.basename(file));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await noConsentDialog(page);
    const chips = await panel.locator('flow-ingredient-chip:visible, .ingredient-chip:visible, [data-testid="reference-chip"]:visible').evaluateAll((elements) => elements.map((element) => ({
      text: [element.textContent, element.getAttribute("aria-label"), element.getAttribute("title"), ...Array.from(element.querySelectorAll("img"), (image) => image.alt)].filter(Boolean).join(" "),
      ready: element.getAttribute("aria-busy") !== "true" && !element.querySelector('[role="progressbar"], [aria-busy="true"]') && Array.from(element.querySelectorAll("img")).some((image) => image.complete && image.naturalWidth > 0),
    })));
    if (chips.length === names.length && names.every((name) => chips.some((chip) => chip.ready && chip.text.includes(name)))) return;
    await page.waitForTimeout(200);
  }
  throw unavailable("ảnh tham chiếu đã tải xong và gắn vào prompt");
}

/** Prepare only. The caller owns the persisted, single submission click. */
export async function prepareFlow(page, task, files) {
  if (!["text", "reference"].includes(task.mode)) {
    throw new StudioError(
      "Chế độ khung đầu/cuối và kéo dài Flow chưa được xác minh thao tác gắn tệp riêng. Chưa tải tệp và chưa gửi yêu cầu tạo.",
      "PROVIDER_SETTING_UNAVAILABLE",
    );
  }
  if ((task.mode === "text" && files.length) || (task.mode === "reference" && !files.length)) throw unavailable("ảnh tham chiếu phù hợp chế độ");
  if (!["image", "video"].includes(task.kind)) throw unavailable("loại nội dung");
  const input = await openFlowProject(page);
  let settingsOpened = false;
  const openSettings = async (reopen = false) => {
    if (settingsOpened && !reopen) return;
    const settings = await visibleItems(page.getByRole("button", { name: /^(settings|cài đặt|Điều kiện kích hoạt cài đặt)$/i }));
    if (settings.length !== 1) return;
    settingsOpened = true;
    if (await settings[0].getAttribute("aria-expanded") !== "true") await settings[0].click();
  };
  const fields = [{
    label: "Content type", name: /content type|loại nội dung/i,
    labels: task.kind === "video" ? ["Video", "Videos"] : ["Image", "Images", "Hình ảnh"],
    current: /^(Video|Videos|Image|Images|Hình ảnh)$/i,
  }];
  if (task.kind === "video") fields.push({
    label: "Mode", name: /^(mode|generation mode|chế độ)$/i,
    labels: task.mode === "text" ? ["Text to Video", "Văn bản thành video"] : ["Ingredients to Video", "Thành phần thành video"],
    current: /text to video|ingredients to video|frames to video|văn bản thành video|thành phần thành video|khung hình thành video/i,
  });
  fields.push({
    label: "Model", name: /^(model|select model|chọn nhóm mô hình|mô hình)$/i,
    labels: [task.model, task.model.replace(" 3.1 ", " 3.1 - ")],
    current: /Veo|Omni|Nano Banana|Select model|Chọn nhóm mô hình/i,
  });
  const ratioLabels = {
    "9:16": ["9:16", "Portrait (9:16)", "Portrait", "Dọc (9:16)", "Dọc"],
    "16:9": ["16:9", "Landscape (16:9)", "Landscape", "Ngang (16:9)", "Ngang"],
    "1:1": ["1:1", "Square (1:1)", "Square", "Vuông"],
  };
  if (!ratioLabels[task.ratio]) throw unavailable("tỷ lệ");
  fields.push({ label: "Aspect ratio", name: /aspect ratio|tỷ lệ/i, labels: ratioLabels[task.ratio], current: /portrait|landscape|square|9:16|16:9|1:1|tỷ lệ/i });
  fields.push({ label: "Outputs per prompt", name: /outputs per prompt|number of outputs|output count|số lượng|số kết quả/i, labels: ["1", "1 output", "1 result", "1 kết quả"], numeric: true });
  if (task.kind === "video") fields.push({ label: "Duration", name: /duration|thời lượng/i, labels: [`${task.duration}s`, `${task.duration} seconds`, `${task.duration} giây`], numeric: true });
  for (const field of fields) await chooseVerified(page, field, openSettings);
  await noConsentDialog(page);
  // Selecting a model/mode can reset other controls; verify all final values.
  for (const field of fields) {
    if (!(await selected(page, field))) throw unavailable(field.label);
  }
  await page.keyboard.press("Escape");
  if (files.length) await attachReferences(page, files);
  await noConsentDialog(page);
  await input.fill(task.prompt);
  const content = await input.evaluate((element) => element.value ?? element.innerText);
  if (content !== task.prompt) throw unavailable("prompt");
  if (files.length) {
    // Attaching an ingredient can also switch model/mode. Re-open settings
    // only to read them; a reset must stop, not silently alter the request.
    await openSettings(true);
    for (const field of fields) {
      if (!(await selected(page, field))) throw unavailable(field.label);
    }
    await page.keyboard.press("Escape");
  }
  const sends = await visibleItems(page.getByRole("button", { name: /^(Bắt đầu tạo|Generate|Start creating|Create|arrow_forward)$/i }));
  if (sends.length !== 1 || !(await sends[0].isEnabled())) throw unavailable("nút tạo");
  return sends[0];
}
