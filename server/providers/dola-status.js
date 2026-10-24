import { StudioError } from "../store.js";

export function dolaQuotaError(text) {
  const dailyLimit = /(?:you(?:'|’)?ve|you have) reached (?:the |your )?daily (?:free )?usage limit for (?:video|image) generation/i.test(text);
  const credits = /(?:not enough|insufficient) (?:video |image )?credits|will use \d+ (?:video )?credits[^\n]*only have \d+[^\n]*left/i.test(text);
  if (!dailyLimit && !credits) return null;
  return new StudioError(
    dailyLimit
      ? "Dola đã hết lượt tạo miễn phí trong ngày. Tác vụ đã dừng theo dõi; không gửi lại tự động. Kiểm tra hạn mức trên Dola trước khi tiếp tục."
      : "Dola không đủ tín dụng cho yêu cầu này. Tác vụ đã dừng; không gửi lại tự động.",
    "PROVIDER_QUOTA",
  );
}
