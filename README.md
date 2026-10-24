# Dropship Studio

Dropship Studio là ứng dụng Windows local để nghiên cứu chủ đề, tạo video AI, dựng timeline và chuẩn bị bài đăng cho Facebook Page.

## Chạy từ source

Yêu cầu Node.js 22 và FFmpeg/ffprobe có trong `bin/` hoặc trên `PATH`.

```powershell
npm ci
npm run build
npm run desktop
```

Ứng dụng mở một cửa sổ Electron, tự khởi động server local và hiển thị màn hình loading trước khi giao diện sẵn sàng. Dữ liệu người dùng nằm trong thư mục `Dropship Data` cạnh file EXE khi chạy bản portable.

## Tạo file EXE Windows

```powershell
npm ci
npm run pack:portable
npm run pack:installer
```

Các file phát hành được ghi vào `release/`. Bản installer có thể bấm để cài; bản portable có thể bấm chạy trực tiếp. Cả hai đều dùng icon Dropship Studio được cấu hình trong `build/icon.ico`.

Trước khi phát hành, chạy:

```powershell
npm test
npm run build
npm run test:ui
```

## GitHub Releases

Workflow `.github/workflows/release.yml` tạo bản Windows khi đẩy tag dạng `v*` hoặc khi chạy thủ công từ Actions. Workflow chỉ đóng gói và tạo GitHub Release; nó không chứa tài khoản AI, cookie, Meta token hay dữ liệu trong `.studio/`.

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Repository URL và quyền `contents: write` phải được cấu hình ở GitHub trước khi dùng workflow phát hành. Không commit `release/`, `.studio/`, profile trình duyệt, media hoặc secrets.
