# Viral Studio 0.7.2 — sử dụng kho và quản lý nhiều bài

Mở `Viral.Studio.0.7.2.exe` để chạy trực tiếp. `Viral.Studio.Setup.0.7.2.exe` là bộ cài, chỉ dùng khi muốn cài ứng dụng. Tên phiên bản không còn hậu tố local.

## Bài không đăng được

App tự trả bài về kho khi gặp lỗi không thể tự thử tiếp hoặc hết ba lần thử lỗi tạm thời. Video, tiêu đề, caption, bài News, bình luận và lỗi cũ đều được giữ. Page và lịch cũ được gỡ; bài không tự đăng lại.

- Vào **Content Studio → Đã trả về kho**, hoặc **Page & bài đăng → Trong kho**.
- Chọn bài, dùng **Đổi Page / nhóm** để gắn Page hoạt động, sửa nội dung nếu cần.
- Khi muốn đăng, chọn **Hẹn giờ đăng** hoặc **Đăng / thử lại**, kiểm tra bản xem trước rồi áp dụng.
- Muốn chủ động lấy một hoặc nhiều bài chưa đăng về kho, chọn **Trả về kho** trong Chi tiết hoặc Thao tác hàng loạt.

Nếu video đã lên Facebook nhưng bình luận bị lỗi, app giữ bài ở luồng sửa bình luận và dùng lại video đó. Không trả video đã đăng về kho để tránh đăng trùng.

## Bài đã đăng

Khi video và bình luận đã hoàn tất, app tự xóa bản nháp khỏi hàng chờ và dọn video trong kho nếu video không còn được bài khác, timeline hoặc tác vụ đang chạy sử dụng. Video được dùng chung vẫn được giữ cho các bài còn lại.

**Lịch sử đã đăng** giữ link Facebook và kết quả đăng. Đây là lịch sử đối chiếu, không phải bản nháp đang chờ đăng. Xóa hoặc dọn trong app không xóa bài trên Facebook.

## Sửa tất cả bài đang chọn

1. Lọc danh sách, tích những bài cần sửa. **Chọn trang này** chọn trang hiện tại; **Chọn cả N kết quả lọc** chọn cả những trang chưa mở.
2. Bấm **Sửa N bài đã chọn** ở thanh chọn, hoặc chọn **Sửa nội dung đã chọn** trong Thao tác hàng loạt.
3. Sửa riêng từng bài trong danh sách. Có thể mở **Điền một trường cho tất cả N bài**, chọn trường và bấm **Điền cho N bài** để đặt cùng một giá trị.
4. Xem số bài sẽ lưu và lý do những bài bị bỏ qua. Bấm **Lưu thay đổi cho N bài**. Bài thay đổi trở về nháp và giữ chờ, không tự đăng.

Nếu mở Chi tiết khi đang chọn nhiều bài, dùng **Trước / Tiếp** để xem các bài đã chọn, hoặc bấm **Sửa N bài đã chọn** để sửa cả nhóm. Những bài đang đăng, đã đăng hoặc vừa được thay đổi ở nơi khác được bảo vệ.

## Quản lý Page

**Channels & Tokens → Page & avatar** có lọc lỗi, nhóm, token, nguồn, trạng thái quản lý và hạn kiểm tra. Bấm tên Page để xem lỗi đầy đủ, ghi chú và lịch sử; chọn nhiều Page để chuyển/gỡ/thêm nhóm, chuyển chờ xử lý, lưu trữ hoặc đưa vào thùng rác.

- **Thêm Page → Từ token đã lưu:** tải danh sách và chọn Page muốn nhập.
- **Thêm Page → Nhập ID / CSV / JSON:** dán danh sách hoặc tải tệp; xem trước dòng trùng/lỗi, chọn nguồn để theo dõi. Page chưa có token vẫn quản lý được nhưng cần token phù hợp trước khi đăng.
- **Kiểm tra lại:** chỉ đọc thông tin Page, có tiến trình và nút dừng. Đọc được Page không chứng minh đã hết hạn chế đăng.
- Sau khi xử lý trên Facebook, chọn **Đưa về nhóm đăng** và xác nhận nếu Page từng bị hạn chế. Việc này không bật Auto Post hay tự đăng lại bài cũ.
- **Lưu trữ / Thùng rác:** chọn trong bộ lọc, rồi **Khôi phục** từ Thao tác hàng loạt. Page quay về chờ kiểm tra. Đồng bộ token không tự hồi sinh Page đã xóa.

Tối đa 5.000 mục cho một thao tác. Nhập CSV/JSON tối đa 2 MB. Có **Xuất CSV** cho kết quả lọc, mục đã chọn và kết quả xử lý.
