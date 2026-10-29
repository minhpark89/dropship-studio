# Viral Studio v0.6.5 checkpoint

## Mục tiêu

Sửa nhầm màn hình quản lý bài đăng: `Page & bài đăng` phải là hàng chờ/trạng thái, không lặp lại các thẻ bìa và video đã có trong Thư viện.

## Đã làm

- Giữ bảng `Bài đăng & trạng thái` làm nguồn theo dõi duy nhất trên màn hình Page & bài đăng.
- Ẩn giao diện biên tập cũ gồm danh sách card, thumbnail, tên file video và nút thao tác trùng lặp.
- Hiển thị rõ trạng thái thiếu Content, sẵn sàng, đã hẹn giờ, đang đăng, lỗi và đã đăng Meta.
- Nhóm Page bật Auto Post tiếp tục lấy các Content đủ điều kiện chưa gán nhóm từ kho theo lịch nhóm; video/bìa chỉ quản lý trong Thư viện.
- Giữ phần cấu hình Page/token/group ở `Channels & Tokens` và Content ở `Content Studio`.

## Kiểm chứng cần chạy trước bàn giao

1. `npm run build`
2. `npm run test`
3. `npm run test:workspaces`
4. `node tests/desktop.mjs --packaged`

## Phục hồi

Nếu cần quay lại, dùng tag `v0.6.4`. Bản này không xoá dữ liệu local và không xoá các file release cũ đang được app sử dụng.
