# SA CTEL Daily Project Map

Giao diện mobile-first để theo dõi nhanh các dự án mà team SA CTEL đang handle trong ngày.

## Điểm chính

- Chỉ đọc dữ liệu từ backend API
- Không dùng `localStorage`
- Không có dữ liệu demo
- Không có nút `Nạp demo` và `Xóa dữ liệu`
- Có pixel map mô phỏng project assignment theo zone và theo từng thành viên
- Có thể lọc nhanh theo từng người trong team

## API đang dùng

Khai báo trong `config.js`:

```js
window.APP_CONFIG = {
  apiBaseUrl: 'https://ctel-csdp-worker.thanhlm120797.workers.dev'
};
```

Frontend sẽ gọi:

- `GET /health`
- `GET /api/projects`

## Cách chạy

Chỉ cần host static các file sau:

- `index.html`
- `styles.css`
- `app.js`
- `config.js`

Ví dụ mở bằng:

- GitHub Pages
- Cloudflare Pages
- nginx / Apache
- VS Code Live Server

## Ghi chú mapping

Frontend tự ánh xạ dữ liệu backend sang mô hình hiển thị:

- `owner` -> tên thành viên trong team SA CTEL
- `stage` -> zone trên pixel map
- `health_status` -> trạng thái hiển thị trên card dự án
- `health_score` -> điểm health để tính summary

Nếu tên `owner` từ backend không khớp với danh sách team hiện tại thì dự án vẫn hiển thị trong list, nhưng trên pixel map sẽ rơi vào nhóm `Other`.
