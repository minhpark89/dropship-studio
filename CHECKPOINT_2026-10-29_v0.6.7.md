# Viral Studio v0.6.7 checkpoint

Bản phát hành này bao gồm toàn bộ sửa lỗi Auto Post của v0.6.6 và khóa lỗi scheduler tự xếp lặp slot tương lai sau mỗi vòng kiểm tra.

- Page Meta trong nhóm được tự tạo binding local khi cần.
- Content/video đủ điều kiện được lấy lần lượt theo thời gian tạo.
- Lịch dùng múi giờ nhóm, mặc định `Asia/Bangkok`.
- Có thể đăng ngay thông qua nhóm Auto Post hoặc hẹn theo slot.
- Nếu đã có bài của nhóm đang hẹn trong tương lai, scheduler chờ slot đó xử lý xong rồi mới lấy bài tiếp theo.
- GitHub Release có portable, installer, blockmap, latest.yml và SHA256SUMS.

Kiểm chứng: social tests 8/8, full tests 171/171, workspace browser, build và packaged desktop smoke test.
