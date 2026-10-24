import { StudioError } from "../store.js";
import { flowResponseError } from "./flow-rpc.js";

export const flowComposer = (page) => page.locator(
  'div.ProseMirror[contenteditable="true"]:visible, [data-placeholder][contenteditable="true"]:visible, textarea:not([name="g-recaptcha-response"]):visible',
).first();

export function isFlowRpc(url) {
  try {
    const parsed = new URL(url);
    return ["flow.google.com", "labs.google"].includes(parsed.hostname) &&
      /\/data\/batchexecute$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function dismissProductUpdate(page) {
  for (const dialog of await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').all()) {
    const text = await dialog.innerText().catch(() => "");
    if (!/nano banana|what's new|changelog|new features/i.test(text)) continue;
    const close = dialog.getByRole("button", { name: /get started|bắt đầu|close|đóng/i }).first();
    if (await close.count() !== 1) throw new StudioError("Flow đang hiển thị cập nhật sản phẩm; hãy đóng hộp thoại trong cửa sổ tài khoản.", "PROVIDER_NOT_READY");
    await close.click({ timeout: 5000 });
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
  }
}

export async function openFlowProject(page, { timeout = 30000 } = {}) {
  let failure = null;
  const listener = async (response) => {
    if (!isFlowRpc(response.url())) return;
    try {
      const error = flowResponseError(response.status(), await response.text());
      if (error) failure = new StudioError(error.message, error.code);
    } catch {
      // A closed page is handled by the normal navigation/wait path.
    }
  };
  page.on("response", listener);
  try {
    await page.goto("https://flow.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    const deadline = Date.now() + timeout;
    const create = page.getByRole("button", {
      name: /^(?:add\s*)?(New project|Dự án mới|Create project|Tạo dự án|New canvas|Canvas mới)$/i,
    }).first();
    while (!(await create.isVisible())) {
      if (failure) throw failure;
      await dismissProductUpdate(page);
      if (/accounts\.google\.com|\/about(?:[/?#]|$)/.test(page.url())) {
        throw new StudioError(
          "Phiên Google Flow đã đăng xuất. Đăng nhập Google trong cửa sổ tài khoản rồi kiểm tra lại phiên; chưa gửi yêu cầu tạo.",
          "NEEDS_LOGIN",
        );
      }
      if (Date.now() >= deadline) {
        throw new StudioError("Flow chưa mở danh sách dự án. Kiểm tra cửa sổ tài khoản; chưa gửi yêu cầu tạo.", "PROVIDER_NOT_READY");
      }
      await page.waitForTimeout(250);
    }
    await dismissProductUpdate(page);
    const dialog = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible');
    if (await dialog.count()) {
      throw new StudioError(
        "Flow đang có hộp thoại cần bạn xử lý trong cửa sổ tài khoản; chưa gửi yêu cầu tạo.",
        "NEEDS_LOGIN",
      );
    }
    if (failure) throw failure;
    await create.click({ timeout: 10000 });
    while (!(await flowComposer(page).isVisible())) {
      if (failure) throw failure;
      await dismissProductUpdate(page);
      const body = await page.locator("body").innerText({ timeout: 5000 });
      if (/failed to create project|không thể tạo dự án/i.test(body)) {
        // Let the RPC listener finish decoding the server's actual reason.
        await page.waitForTimeout(200);
        if (failure) throw failure;
        throw new StudioError("Flow từ chối tạo dự án. Chưa gửi prompt và chưa tạo video.", "PROVIDER_REJECTED");
      }
      if (Date.now() >= deadline) {
        throw new StudioError("Flow chưa mở ô nhập trong dự án mới; chưa gửi yêu cầu tạo.", "PROVIDER_NOT_READY");
      }
      await page.waitForTimeout(250);
    }
    await dismissProductUpdate(page);
    if (failure) throw failure;
    return flowComposer(page);
  } finally {
    page.off("response", listener);
  }
}
