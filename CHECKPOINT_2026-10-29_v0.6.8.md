# Viral Studio v0.6.8 checkpoint

Sửa lỗi đổi giờ nhóm Page: bài Auto Post đã hẹn trong tương lai được tính lại theo khung giờ và múi giờ mới của nhóm.

- Không cần chọn từng bài trong `Bài đăng & trạng thái` khi Auto Post đã bật.
- Nhóm `test` dùng `Asia/Bangkok` (UTC+7); đổi sang 18:05 sẽ dời slot Auto Post theo 18:05.
- Scheduler vẫn tránh tạo slot trùng ở mỗi vòng kiểm tra.
- GitHub Release có portable, installer, blockmap, latest.yml và SHA256SUMS.

Kiểm chứng: social tests 8/8, build và packaged smoke test đạt trên bản 0.6.8.
