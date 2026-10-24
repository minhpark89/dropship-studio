import { StudioError } from "../store.js";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const visible = (locator) =>
  locator
    .first()
    .isVisible()
    .catch(() => false);

export const dolaVideoCards = (page) =>
  page.locator('[data-testid="receive_message"] [class*="block-video-"]');

export async function activateDolaVideo(page, baselineCount, activated) {
  const cards = dolaVideoCards(page);
  for (let index = baselineCount; index < (await cards.count()); index++) {
    if (activated.has(index)) continue;
    const card = cards.nth(index);
    const play = card.locator('[class*="play-icon-wrapper-"]');
    if (!(await visible(play))) continue;
    try {
      // Dola mounts the player and requests its media URL only after play.
      // This opens a completed result; it never sends another generation.
      await card.click({ timeout: 2000 });
      activated.add(index);
      return true;
    } catch {
      // A temporary overlay can block the result; retry during the next poll.
    }
  }
  return false;
}

async function configureVideo(page, task, log) {
  const modelButton = page.getByRole("button", { name: /^(Model|Mô hình)\s/ });
  await modelButton.waitFor({ state: "visible", timeout: 15000 });
  const requested =
    task.model === "Seedance" ? "Dreamina Seedance 2.0 Fast" : task.model;
  if (!(await modelButton.innerText()).includes(requested)) {
    await modelButton.click();
    const option = page.getByRole("menuitem", {
      name: new RegExp(`^${escapeRegex(requested)}(?:\\s|$)`),
    });
    if (!(await visible(option))) {
      await page.keyboard.press("Escape");
      throw new StudioError(
        `Tài khoản Dola hiện không có model ${requested}. Chưa gửi yêu cầu.`,
        "PROVIDER_SETTING_UNAVAILABLE",
      );
    }
    await option.click();
  }
  const settings = page.getByRole("button", {
    name: /^(?:Auto|Tự động|\d+:\d+)\s*·\s*\d+s$/,
  });
  await settings.click();
  const ratio = page.getByRole("button", { name: task.ratio, exact: true });
  if (!(await visible(ratio))) {
    throw new StudioError(
      `Dola không có lựa chọn tỷ lệ ${task.ratio}. Chưa gửi yêu cầu.`,
      "PROVIDER_SETTING_UNAVAILABLE",
    );
  }
  await ratio.click();
  let slider = page.getByRole("slider");
  if (!(await visible(slider))) await settings.click();
  slider = page.getByRole("slider");
  await slider.press("Home");
  const duration = async () => {
    const text = await settings.innerText();
    return Number(text.match(/·\s*(\d+)s/)?.[1]);
  };
  await page.waitForTimeout(80);
  let current = await duration();
  for (let count = 0; current < task.duration && count < 60; count++) {
    const previous = current;
    await slider.press("ArrowRight");
    await page.waitForTimeout(50);
    current = await duration();
    if (current === previous) break;
  }
  await page.keyboard.press("Escape");
  if (
    current !== task.duration ||
    !(await settings.innerText()).startsWith(task.ratio)
  ) {
    throw new StudioError(
      `Không đặt được ${task.ratio}, ${task.duration} giây trên Dola. Website đang hiển thị ${await settings.innerText()}. Chưa gửi yêu cầu.`,
      "PROVIDER_SETTING_UNAVAILABLE",
    );
  }
  const selectedModel = (await modelButton.innerText())
    .replace(/^(Model|Mô hình)\s*/, "")
    .trim();
  if (selectedModel !== requested) {
    throw new StudioError(
      "Dola chưa chọn đúng model yêu cầu. Chưa gửi prompt.",
      "PROVIDER_SETTING_UNAVAILABLE",
    );
  }
  log(`Website Dola đã chọn ${selectedModel}, ${task.ratio}, ${current} giây.`);
  return selectedModel;
}

async function configureImage(page, task, log) {
  const requested = task.model === "Dola Image" ? "Seedream 4.5" : task.model;
  const model = page.getByRole("button", { name: /^(Model|Mô hình)\s/ });
  await model.waitFor({ state: "visible", timeout: 15000 });
  if (!(await model.innerText()).includes(requested)) {
    await model.click();
    const option = page.getByRole("menuitem", {
      name: new RegExp(`^${escapeRegex(requested)}(?:\\s|$)`),
    });
    if (!(await visible(option))) {
      await page.keyboard.press("Escape");
      throw new StudioError(`Dola chưa có model ảnh ${requested}. Chưa gửi yêu cầu.`, "PROVIDER_SETTING_UNAVAILABLE");
    }
    await option.click();
  }
  const ratioButton = page.getByRole("button", { name: /^(Aspect ratio|Tỷ lệ)\s/ });
  await ratioButton.click();
  const ratio = page.getByRole("button", { name: task.ratio, exact: true });
  if (!(await visible(ratio))) {
    await page.keyboard.press("Escape");
    throw new StudioError(`Dola chưa có tỷ lệ ảnh ${task.ratio}. Chưa gửi yêu cầu.`, "PROVIDER_SETTING_UNAVAILABLE");
  }
  await ratio.click();
  await page.keyboard.press("Escape");
  if (!(await model.innerText()).includes(requested) || !(await ratioButton.innerText()).includes(task.ratio)) {
    throw new StudioError("Dola chưa chọn đúng model hoặc tỷ lệ ảnh. Chưa gửi yêu cầu.", "PROVIDER_SETTING_UNAVAILABLE");
  }
  log(`Website Dola đã chọn ${requested}, ảnh ${task.ratio}.`);
}

export async function prepareDola(page, task, files, log) {
  await page.goto("https://www.dola.com/chat/", {
    waitUntil: "domcontentloaded",
  });
  const fresh = page.getByTestId("create_conversation_button");
  await fresh.waitFor({ state: "visible", timeout: 15000 });
  await fresh.click();
  await page
    .getByTestId(
      task.kind === "image" ? "skill_bar_button_3" : "skill_bar_button_17",
    )
    .click();
  if (await visible(page.getByTestId("login_content"))) {
    throw new StudioError("Phiên Dola đã hết hạn.", "NEEDS_LOGIN");
  }
  if (task.mode === "firstlast" || task.mode === "extend") {
    const label =
      task.mode === "firstlast"
        ? /^(First and last frames|First & last frame|Frames to video|Khung hình đầu và cuối)$/i
        : /^(Extend|Extend video|Kéo dài video|Mở rộng video)$/i;
    const mode = page.getByRole("button", { name: label });
    if (!(await visible(mode))) {
      throw new StudioError(
        "Website Dola của tài khoản này chưa có chế độ khung đầu/cuối hoặc kéo dài riêng. Chưa gửi yêu cầu; có thể dùng chế độ ảnh tham chiếu nếu phù hợp.",
        "PROVIDER_SETTING_UNAVAILABLE",
      );
    }
    await mode.click();
  }
  if (task.kind === "video") await configureVideo(page, task, log);
  else await configureImage(page, task, log);
  if (files.length) {
    const input = page.getByTestId("upload-file-input");
    if (await input.count()) await input.setInputFiles(files);
    else await page.locator('input[type="file"]').first().setInputFiles(files);
    await page.waitForTimeout(1500);
  }
  const container = page.getByTestId("chat_input_input");
  const editor = container.locator('[contenteditable="true"]').first();
  const input = (await editor.count()) ? editor : container;
  const specification =
    task.kind === "video"
      ? `Create one video. Duration: ${task.duration} seconds. Aspect ratio: ${task.ratio}.`
      : `Create one image. Aspect ratio: ${task.ratio}.`;
  const reference = files.length
    ? " Use the attached files as visual references for this request."
    : "";
  await input.fill(`${specification}${reference}\n\n${task.prompt}`);
  return page.getByTestId("chat_input_send_button");
}
