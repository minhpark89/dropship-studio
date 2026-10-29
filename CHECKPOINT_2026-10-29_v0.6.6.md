# Viral Studio v0.6.6 checkpoint

## Vấn đề đã sửa

Nhóm Page có Page Meta và token hợp lệ nhưng không có Page local nên các Content vẫn ở nháp, không được đưa vào lịch và không có tác vụ đăng khi đến giờ.

## Hành vi mới

- Scheduler tự tạo binding Page local từ các Page Meta đã có trong nhóm.
- Content có video, caption, first comment và article body hợp lệ được lấy theo thứ tự tạo và đưa vào slot nhóm.
- Lịch nhóm dùng `scheduleConfig.timezone`, mặc định `Asia/Bangkok`.
- Hàng chờ có thể chọn nhóm Auto Post để `Đăng ngay`; không cần chọn Page thủ công cho từng bài.
- `Page & bài đăng`/`Bài đăng & trạng thái` chỉ hiển thị trạng thái hàng chờ, lịch, lỗi và lịch sử Meta; video/bìa vẫn ở Thư viện.

## Release

- Portable: `release/Viral Studio 0.6.6.exe`
- Installer: `release/Viral Studio Setup 0.6.6.exe`
- Git tag: `v0.6.6`
- GitHub Release phải có cả portable, installer, blockmap và `latest.yml`.

## Kiểm chứng

- `node --test --test-concurrency=1 tests/social.test.js` — 8/8
- `npm run build` — đạt
- Full test, workspace browser test và packaged desktop smoke test phải chạy lại trước khi bàn giao.
