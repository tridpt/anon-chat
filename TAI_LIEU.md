# Tài liệu dự án GhostChat (anon-chat)

> Tài liệu kỹ thuật chi tiết cho ứng dụng trò chuyện ẩn danh 1-1 ghép cặp theo sở thích.

---

## 1. Giới thiệu tổng quan

**GhostChat** là một ứng dụng web cho phép hai người lạ trò chuyện ẩn danh theo thời gian thực, được ghép cặp dựa trên **sở thích chung** và **ngôn ngữ ưu tiên**. Ứng dụng:

- **Không tạo tài khoản**, không yêu cầu đăng nhập.
- **Lưu transcript có kiểm soát** — tin nhắn được che từ nhạy cảm và lưu trong `data/chats.json` để moderator xem, tự dọn theo thời hạn trong Settings; người dùng có thể đánh giá sau chat và gửi report + block khi thấy không an toàn.
- Có cơ chế an toàn: chặn, báo cáo, lọc từ ngữ xấu, tự động cấm tạm thời, và một trang kiểm duyệt riêng.

Mỗi khách truy cập được gán một `clientId` ngẫu nhiên lưu trong trình duyệt (localStorage). Đây không phải tài khoản — xóa dữ liệu trình duyệt sẽ tạo `clientId` mới. `clientId` chỉ dùng để tránh ghép lại với người đã chặn và để gắn báo cáo/cấm.

---

## 2. Tính năng

| Nhóm       | Tính năng                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ghép cặp   | Ghép theo sở thích chung, ưu tiên ngôn ngữ tương thích (Việt/Anh/bất kỳ), ưu tiên mềm theo phản hồi, cooldown cặp không phù hợp có thể chỉnh trong Settings, fallback sau 5 giây chờ |
| Trò chuyện | Nhắn tin thời gian thực, chỉ báo "đang gõ", âm thanh thông báo, tự kết nối lại sau mất mạng                                                                                          |
| Gợi ý      | Câu mở lời (icebreaker) theo sở thích chung và ngôn ngữ                                                                                                                              |
| Hàng đợi   | Hiển thị số người đang chờ, ước tính thời gian chờ, số người trực tuyến                                                                                                              |
| Cảm xúc    | Emoji picker khi soạn tin; thả reaction emoji lên từng tin nhắn                                                                                                                      |
| Giao diện  | Chuyển dark/light theme; đổi ngôn ngữ giao diện Việt/Anh (i18n); mobile-first với khung chat theo bàn phím và vùng an toàn màn hình                                                  |
| Thông báo  | Báo trình duyệt khi được ghép cặp/có tin mới lúc tab ẩn; badge + nút xem tin mới khi đang đọc phía trên                                                                              |
| An toàn    | Bỏ qua (skip), chặn (block) có xác nhận, bỏ chặn, báo cáo với lý do, đánh giá sau chat                                                                                               |
| Phản hồi   | Đánh giá sau chat kèm lý do nhanh khi không phù hợp; admin xem tỷ lệ, xu hướng 14 ngày, lý do không phù hợp và lọc chat không an toàn                                                |
| Kiểm duyệt | Lọc từ ngữ xấu, giới hạn link, tự động cấm theo số report; admin chỉnh thông số runtime tại trang `/admin`                                                                           |
| Khiếu nại  | Người bị ban gửi appeal; moderator duyệt/từ chối, duyệt sẽ gỡ ban và giữ liên kết report/transcript                                                                                  |
| Vận hành   | Endpoint `/health` với số liệu; ban lưu bền vững qua restart                                                                                                                         |
| Mở rộng    | Redis adapter tùy chọn cho nhiều instance                                                                                                                                            |

---

## 3. Công nghệ sử dụng

- **Node.js** (>= 20) — môi trường chạy.
- **Express 5** — phục vụ HTTP, file tĩnh và API admin.
- **Socket.IO 4** — giao tiếp thời gian thực hai chiều (WebSocket).
- **Server-Sent Events (SSE)** — đẩy thông báo kiểm duyệt mới tới phiên admin đang đăng nhập.
- **socket.io-client** — chỉ dùng cho bộ kiểm thử.
- **node:test** — bộ kiểm thử tích hợp sẵn của Node, không cần thư viện ngoài.
- **redis** + **@socket.io/redis-adapter** — _tùy chọn_ (optionalDependencies), chỉ nạp khi bật `REDIS_URL`.
- **Frontend** — HTML/CSS/JavaScript thuần (vanilla), không framework. Font Awesome và Google Fonts qua CDN.

---

## 4. Cấu trúc thư mục

```
anon-chat/
├── index.js                  # Toàn bộ logic server (HTTP + Socket.IO + matchmaking)
├── package.json              # Metadata, scripts, dependencies
├── package-lock.json
├── Dockerfile                # Image production (node:22-alpine)
├── .dockerignore
├── .gitignore
├── README.md                 # Hướng dẫn ngắn (tiếng Anh)
├── TAI_LIEU.md               # Tài liệu chi tiết này
├── data/                     # Dữ liệu bền vững (gitignored): reports, appeals, bans, chats, settings, moderator accounts, audit logs
├── public/                   # Tài nguyên frontend tĩnh
│   ├── index.html            # Giao diện chat chính
│   ├── script.js             # Logic client
│   ├── i18n.js               # Hệ thống đa ngôn ngữ (Việt/Anh)
│   ├── style.css             # Toàn bộ style + biến theme
│   ├── admin.html            # Trang kiểm duyệt
│   ├── admin.js              # Logic trang kiểm duyệt
│   └── admin.css             # Style trang kiểm duyệt
└── test/
    └── chat-server.test.js   # Bộ kiểm thử tích hợp
```

---

## 5. Kiến trúc tổng thể

```
   Trình duyệt A                    Server (Node.js)                 Trình duyệt B
 ┌──────────────┐         ┌───────────────────────────────┐      ┌──────────────┐
 │ index.html   │         │ Express  ── file tĩnh, /admin  │      │ index.html   │
 │ script.js    │◄──────► │           ── /health, /api/... │◄────►│ script.js    │
 │ i18n.js      │ Socket  │ Socket.IO ── login, message... │ Sock │ i18n.js      │
 │ localStorage │  .IO    │ Matchmaking loop (2s)          │ .IO  │ localStorage │
 └──────────────┘         │ report/ban/chat/audit stores   │      └──────────────┘
                          │ (tùy chọn) Redis adapter       │
                          └───────────────────────────────┘
                                        │
                                   data/*.json
```

**Luồng chính của một phiên:**

1. Người dùng nhập biệt danh, sở thích, ngôn ngữ, tích xác nhận 18+ và Quy tắc Cộng đồng, bấm "Bắt đầu".
2. Client mở kết nối Socket.IO và phát sự kiện `login` với hồ sơ + `clientId` + danh sách đã chặn.
3. Server validate, kiểm tra lệnh cấm, rồi đưa socket vào **hàng đợi** (`waitingQueue`).
4. Mỗi 2 giây (và mỗi khi có người mới vào hàng đợi), server chạy thuật toán ghép cặp.
5. Khi ghép được, cả hai vào chung một "room" (UUID), nhận sự kiện `matched` với thông tin đối phương + sở thích chung.
6. Tin nhắn, "đang gõ", reaction được chuyển tiếp trong room.
7. Người dùng có thể `skip` (tìm người mới), `blockPartner` (chặn), `reportPartner` (báo cáo). Tất cả đều đưa họ trở lại hàng đợi (trừ báo cáo có thể kèm chặn).
8. Khi ngắt kết nối, server dọn dẹp hàng đợi và phòng, thông báo cho đối phương.

---

## 6. Backend chi tiết — `index.js`

Toàn bộ server nằm trong một file. Hàm trung tâm là `createChatServer(options)` trả về `{ app, server, io, close }`, giúp dễ kiểm thử (bộ test tạo nhiều server trên cổng ngẫu nhiên).

### 6.1. Hằng số & giới hạn (`LIMITS`)

Đối tượng `LIMITS` tập trung mọi giới hạn để dễ chỉnh:

| Khóa                      | Giá trị                              | Ý nghĩa                                |
| ------------------------- | ------------------------------------ | -------------------------------------- |
| `maxUsernameLength`       | 20                                   | Độ dài tối đa biệt danh                |
| `maxInterestsInputLength` | 200                                  | Độ dài tối đa chuỗi sở thích nhập vào  |
| `maxInterestLength`       | 30                                   | Độ dài tối đa một sở thích             |
| `maxInterests`            | 10                                   | Số sở thích tối đa                     |
| `maxMessageLength`        | 500                                  | Độ dài tối đa một tin nhắn             |
| `maxReportReasonLength`   | 300                                  | Độ dài tối đa lý do báo cáo            |
| `maxBlockedClientIds`     | 100                                  | Số người chặn tối đa gửi lên           |
| `maxQueueSize`            | 1000                                 | Sức chứa hàng đợi                      |
| `maxPayloadBytes`         | 10000                                | Kích thước payload Socket.IO tối đa    |
| `messageRate`             | 8 / 10s                              | Giới hạn gửi tin nhắn                  |
| `typingRate`              | 1 / 750ms                            | Giới hạn sự kiện "đang gõ"             |
| `skipRate`                | 5 / 10s                              | Giới hạn bỏ qua                        |
| `reactionRate`            | 15 / 10s                             | Giới hạn thả reaction                  |
| `loginRate`               | 3 / 60s                              | Giới hạn đăng nhập                     |
| `blockRate`               | 5 / 60s                              | Giới hạn chặn                          |
| `reportRate`              | 3 / 60 phút                          | Giới hạn báo cáo                       |
| `appealRate`              | 2 / 24 giờ                           | Giới hạn gửi khiếu nại theo IP         |
| `maxAppealMessageLength`  | 1000                                 | Độ dài tối đa lời giải thích khiếu nại |
| `maxLinksPerMessage`      | 3                                    | Số link tối đa trong một tin nhắn      |
| `autoBan`                 | ngưỡng 3, cửa sổ 60 phút, cấm 24 giờ | Tham số tự động cấm                    |

Các tập hợp/hằng khác:

- `COLORS` — bảng màu gán ngẫu nhiên cho mỗi socket (màu hiển thị tên).
- `REPORT_STATUSES` = `{new, reviewed, resolved}`.
- `APPEAL_STATUSES` = `{pending, approved, rejected}`.
- `LANGUAGES` = `{any, vi, en}`.
- `REACTION_EMOJIS` = `{👍 ❤️ 😂 😮 😢 🔥}` — tập emoji reaction hợp lệ.
- `PROFANITY` — danh sách từ cấm (Anh + Việt), dùng tạo `PROFANITY_PATTERN`.
- `URL_PATTERN` — regex phát hiện link.

### 6.2. Hàm tiện ích & validation

- `isPlainObject(value)` — kiểm tra object thuần.
- `cleanText(value)` — bỏ ký tự điều khiển, trim, gom khoảng trắng thừa.
- `isClientId(value)` — `clientId` hợp lệ là chuỗi `[A-Za-z0-9_-]{16,64}`.
- `parseLogin(data)` — validate toàn bộ hồ sơ đăng nhập: kiểu dữ liệu, ngôn ngữ hợp lệ, **bắt buộc** `safetyAcknowledged === true`, `clientId` hợp lệ, danh sách chặn hợp lệ, độ dài. Trả về `{ value }` đã làm sạch hoặc `{ error }`. Sở thích được tách theo dấu phẩy, viết thường, loại trùng, cắt còn tối đa 10.
- `parseMessage(value)` — kiểm tra kiểu, độ dài, không rỗng.
- `parseReport(data)` — kiểm tra có lý do, độ dài.
- `parseAppeal(data)` — kiểm tra `clientId`, lời giải thích và độ dài khiếu nại.
- `maskProfanity(text)` — thay từ cấm bằng dấu `*` (giữ độ dài). **Che chứ không chặn** để không làm gián đoạn hội thoại.
- `countLinks(text)` — đếm số link để chặn tin spam nhiều link.
- `escapeRegExp(value)` — escape ký tự đặc biệt khi dựng regex từ danh sách từ cấm.

### 6.3. Kho báo cáo — `createReportStore(dataDirectory)`

Quản lý file `data/reports.json` với:

- **Hàng đợi thao tác** (`operationQueue`) — tuần tự hóa mọi thao tác đọc/ghi để tránh race condition.
- **Ghi nguyên tử (atomic)** — ghi ra file `.tmp` rồi `rename` để tránh hỏng file khi ghi dở.
- API: `append(report)`, `list(status?)`, `update(id, changes)`. Dữ liệu trả ra luôn được deep-copy (`copyValue`) để không lộ tham chiếu nội bộ.

Mỗi báo cáo có cấu trúc:

```json
{
  "id": "uuid",
  "createdAt": "ISO-8601",
  "reporter": { "alias": "...", "clientId": "..." },
  "reportedUser": { "alias": "...", "clientId": "..." },
  "reason": "Lý do đã làm sạch",
  "status": "new | reviewed | resolved",
  "moderationNote": "",
  "reviewedAt": null
}
```

### 6.4. Kho cấm — `createBanStore(dataDirectory)`

Quản lý file `data/bans.json`, cùng kỹ thuật atomic write và hàng đợi thao tác:

- `load()` — đọc danh sách cấm, **tự loại bỏ các lệnh cấm đã hết hạn** khi nạp.
- `save(entries)` — ghi danh sách cấm còn hiệu lực.
- Mỗi mục: `{ clientId, banUntil }` (timestamp mili-giây hết hạn).

Kho khiếu nại `createAppealStore(dataDirectory)` lưu `data/appeals.json` bằng hàng đợi thao tác và
ghi nguyên tử. Mỗi mục giữ `clientId`, alias, lời giải thích, snapshot lệnh cấm, `reportId`, trạng thái
`pending | approved | rejected`, ghi chú moderator và thông tin người duyệt. Chỉ một appeal `pending`
được phép tồn tại cho mỗi `clientId`.

### 6.5. Redis adapter (tùy chọn) — `setupRedisAdapter(io, redisUrl, logger)`

- Chỉ chạy khi có `redisUrl`. Nạp `redis` và `@socket.io/redis-adapter` theo kiểu **lazy require**.
- Tạo `pubClient`/`subClient`, gắn `io.adapter(createAdapter(...))` để sự kiện phân phối xuyên instance.
- **Chiến lược reconnect giới hạn**: thử lại tối đa 3 lần rồi báo lỗi và dừng, để startup thất bại nhanh khi Redis không sẵn sàng.
- **Fallback an toàn**: nếu lỗi, log rồi `return null`; server tiếp tục chạy chế độ một-instance. Client lỗi được `destroy()` an toàn để tránh reconnect nền gây spam log.

### 6.6. `createChatServer` — trạng thái và HTTP

Tham số: `{ logger, dataDir, adminToken, adminPath, adminSessionTtlMs, redisUrl }` (mặc định lấy từ biến môi trường).

**Trạng thái trong bộ nhớ:**

- `waitingQueue` — mảng các socket đang chờ ghép.
- `averageMatchWaitMs` — trung bình trượt thời gian chờ (EMA) để ước tính thời gian chờ.
- `totalMatches` — tổng số lần ghép (cho `/health`).
- `recentReportsByClient` — Map theo dõi mốc thời gian báo cáo theo `clientId`.
- `bannedClients` — Map `clientId -> banUntil`.

**Các route HTTP:**

| Method   | Đường dẫn                   | Mô tả                                                                                                             |
| -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET      | `/health`                   | Công khai. Trả `status`, `uptimeSeconds`, `online`, `waiting`, `totalMatches`, `averageMatchWaitMs`, `activeBans` |
| GET      | `/admin`                    | Trả 404 nếu `ADMIN_PATH` đã đổi; đường dẫn cấu hình trả trang `admin.html`                                        |
| POST     | `/api/admin/login`          | Đăng nhập bằng moderator account hoặc đổi `ADMIN_TOKEN` bootstrap lấy phiên ngắn hạn qua cookie HttpOnly          |
| GET      | `/api/admin/session`        | Kiểm tra phiên admin hiện tại                                                                                     |
| POST     | `/api/admin/logout`         | Thu hồi phiên admin hiện tại                                                                                      |
| GET      | `/api/admin/moderators`     | Admin xem danh sách tài khoản moderator                                                                           |
| POST     | `/api/admin/moderators`     | Admin tạo tài khoản moderator (`admin`, `moderator`, hoặc `viewer`)                                               |
| PATCH    | `/api/admin/moderators/:id` | Admin đổi role, mật khẩu, hoặc bật/tắt tài khoản                                                                  |
| GET      | `/api/admin/settings`       | Admin xem giới hạn và giá trị runtime hiện tại                                                                    |
| PATCH    | `/api/admin/settings`       | Admin đổi cooldown `not_a_match`, ngưỡng auto-ban, hoặc thời hạn lưu transcript                                   |
| GET      | `/api/admin/reports`        | Yêu cầu admin. Liệt kê báo cáo, lọc theo `?status=`                                                               |
| PATCH    | `/api/admin/reports/:id`    | Yêu cầu admin. Cập nhật `status` + `moderationNote`                                                               |
| GET      | `/api/admin/chat-feedback`  | Yêu cầu admin. Trả tổng số đánh giá và các cờ an toàn từ transcript                                               |
| GET      | `/api/admin/events`         | Yêu cầu session admin. Luồng SSE báo report/appeal/ban mới để dashboard tự cập nhật                               |
| POST     | `/api/appeals`              | Công khai có giới hạn. Người đang bị ban gửi một lời giải thích khiếu nại                                         |
| GET      | `/api/admin/appeals`        | Yêu cầu admin. Liệt kê appeal, lọc theo `?status=pending`, `approved`, hoặc `rejected`                            |
| PATCH    | `/api/admin/appeals/:id`    | Yêu cầu role moderator. Duyệt (gỡ ban) hoặc từ chối appeal                                                        |
| (static) | `/*`                        | Phục vụ thư mục `public/`                                                                                         |

**Xác thực admin:**

- `POST /api/admin/login` nhận username/password của tài khoản moderator hoặc `ADMIN_TOKEN` bootstrap, sau đó tạo ID phiên ngẫu nhiên trong RAM và gửi cookie `HttpOnly; SameSite=Strict; Path=/api/admin`.
- Tài khoản được lưu trong `data/moderators.json`; mật khẩu dùng `crypto.scrypt` với salt riêng, không lưu plaintext. Có ba role: `admin`, `moderator`, `viewer`.
- `requireAdmin` xác thực principal và chặn truy cập trái phép (401); middleware role giới hạn thao tác thay đổi (moderator) và quản lý đội ngũ (admin). Header `Authorization: Bearer <token>` vẫn được hỗ trợ cho script server-to-server.
- Mỗi request có session named account đều tra lại account; disable hoặc đổi role có hiệu lực ngay. Không thể vô hiệu hóa admin cuối cùng đang hoạt động.
- Phiên mặc định sống 8 giờ (`ADMIN_SESSION_TTL_HOURS`), bị thu hồi khi logout hoặc restart server; đăng nhập bị giới hạn theo IP.
- `express.json({ limit: '5kb' })` giới hạn body API.
- `POST /api/appeals` chỉ nhận `clientId` đang có ban hiệu lực, giới hạn 2 lần mỗi IP trong 24 giờ,
  và yêu cầu same-origin khi trình duyệt gửi request. Duyệt appeal gọi `liftBan()` và ghi audit event.
- `GET /api/admin/events` chỉ nhận cookie session `HttpOnly` hợp lệ (EventSource không gửi bearer
  header), giữ kết nối SSE và tự đóng khi session hết hạn, bị thu hồi, hoặc tài khoản bị vô hiệu hóa.
- Tab **Settings** chỉ dành cho role `admin`. Ba giá trị được validate ở server, áp dụng ngay, ghi audit event,
  lưu ở `data/settings.json`, và được nạp lại khi khởi động. Giảm thời hạn transcript sẽ dọn ngay các chat đã hết hạn.

### 6.7. Thuật toán ghép cặp

Hàm `matchUsers()` chạy định kỳ mỗi 2 giây (`setInterval`, có `.unref()` để không giữ tiến trình sống) và cả khi có người mới vào hàng đợi.

Các bước:

1. **Dọn hàng đợi** — loại các socket đã ngắt kết nối, không còn ở trạng thái chờ, hoặc đã vào phòng.
2. **Quét cặp** — với mỗi `user1`, tìm `user2` tốt nhất qua `getBestMatchIndex` theo thứ tự ưu tiên:
   - (a) Có **sở thích chung** _và_ **ngôn ngữ tương thích**.
   - (b) Có sở thích chung (bỏ qua ngôn ngữ).
   - (c) Ngôn ngữ tương thích _và_ một trong hai đã chờ đủ **5 giây**.
   - (d) Bất kỳ ai (đã chờ đủ 5 giây) — fallback cuối.
   - Trong từng tầng, điểm chất lượng riêng tư làm tiêu chí phụ: chỉ có hiệu lực sau tối thiểu 2 phản hồi từ đối tác, `positive` tăng ưu tiên và `not_a_match` giảm ưu tiên; cùng điểm vẫn theo thứ tự vào hàng đợi. Phản hồi `unsafe` không được dùng để xếp hạng.
   - Nếu một bên chọn `not_a_match`, cặp hai `clientId` được đưa vào cooldown hai chiều theo số ngày trong Settings (mặc định 30). Điều này chỉ loại đúng cặp đó khỏi `canMatch`; mỗi người vẫn được ghép với người khác.
3. **Điều kiện ghép** (`canMatch`): khác `clientId`, và **không bên nào đã chặn bên kia**.
4. **Tương thích ngôn ngữ** (`hasCompatibleLanguage`): một trong hai là `any`, hoặc cùng ngôn ngữ.
5. Khi ghép: tạo `roomId` (UUID), cả hai `join(roomId)`, gán `currentRoom` và `partner` cho nhau, phát `matched` kèm `sharedInterests`, tăng `totalMatches`, cập nhật EMA thời gian chờ.

`getQueueStatus()` trả `{ waitingCount, estimatedWaitSeconds, onlineCount }`. Ước tính thời gian chờ làm tròn theo bậc 5 giây, kẹp trong khoảng 5–120 giây. `broadcastQueueStatus()` phát `queue_status` cho tất cả.

### 6.8. Rate limiting

`isRateLimited(socket, key, { max, windowMs })` — lưu mốc thời gian theo từng `key` trên mỗi socket, lọc các mốc còn trong cửa sổ; nếu đạt `max` thì chặn. Áp dụng cho: login, message, typing, skip, block, report, reaction.

### 6.9. Lọc nội dung & tự động cấm

- Tin nhắn đi qua `parseMessage` → kiểm tra số link (`countLinks` vs `maxLinksPerMessage`) → `maskProfanity` trước khi phát trong room.
- `registerReportAgainst(clientId)` — ghi mốc báo cáo; nếu trong 60 phút đạt ngưỡng của Settings (mặc định **3 báo cáo**), đặt lệnh cấm 24 giờ, lưu bền vững (`persistBans`), trả `true`.
- `isClientBanned(clientId)` — kiểm tra, tự xóa lệnh cấm hết hạn (lazy).
- `removeBannedClient(clientId)` — kéo mọi socket của client bị cấm khỏi hàng đợi/phòng và gửi lỗi `banned`.
- `persistBans()` — gom các lệnh cấm còn hiệu lực, prune lệnh hết hạn, ghi `bans.json`.
- Lúc khởi động: `banStore.load()` nạp lại các lệnh cấm còn hiệu lực vào `bannedClients`.

### 6.10. Xử lý lỗi và dọn dẹp

- `safelyHandle(socket, handler)` — bọc mọi handler sự kiện (cả async) trong try/catch; lỗi được log và gửi `app_error` thay vì làm sập server.
- `sendError(socket, code, message)` — gửi `app_error` nếu socket còn kết nối.
- `handleLeaveRoom(socket)` — rời phòng, dọn `currentRoom`/`partner` cho cả hai, báo `partner_left` cho đối phương.
- `disconnect` — gỡ khỏi hàng đợi, rời phòng, cập nhật trạng thái hàng đợi.
- `close()` — dừng interval ghép cặp, đóng `io`, và `quit()` các client Redis (nếu có).

---

## 7. Bảng tham chiếu sự kiện Socket.IO

### 7.1. Client → Server

| Sự kiện         | Payload                                                                             | Mô tả                             |
| --------------- | ----------------------------------------------------------------------------------- | --------------------------------- |
| `login`         | `{ username, interests, language, safetyAcknowledged, clientId, blockedClientIds }` | Vào hàng đợi sau khi validate     |
| `chatMessage`   | `string`                                                                            | Gửi tin nhắn vào phòng hiện tại   |
| `typing`        | —                                                                                   | Báo đang gõ cho đối phương        |
| `stop_typing`   | —                                                                                   | Báo dừng gõ                       |
| `reactMessage`  | `{ messageId, emoji }`                                                              | Thả reaction lên một tin nhắn     |
| `skip`          | —                                                                                   | Rời người hiện tại, tìm người mới |
| `blockPartner`  | —                                                                                   | Chặn đối phương, tìm người mới    |
| `reportPartner` | `{ reason }`                                                                        | Báo cáo đối phương                |

### 7.2. Server → Client

| Sự kiện                  | Payload                                                                      | Mô tả                                                               |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `queued`                 | —                                                                            | Đã vào hàng đợi                                                     |
| `queue_status`           | `{ waitingCount, estimatedWaitSeconds, onlineCount }`                        | Cập nhật trạng thái hàng đợi                                        |
| `matched`                | `{ partnerName, partnerColor, partnerId, partnerLanguage, sharedInterests }` | Đã ghép cặp                                                         |
| `message`                | `{ type, id, username, color, text, timestamp }`                             | Tin nhắn trong phòng                                                |
| `typing` / `stop_typing` | —                                                                            | Chỉ báo gõ của đối phương                                           |
| `message_reaction`       | `{ messageId, emoji, from }`                                                 | Reaction mới trên một tin nhắn                                      |
| `partner_left`           | —                                                                            | Đối phương đã rời                                                   |
| `partner_blocked`        | `{ partnerName, partnerId }`                                                 | Xác nhận đã chặn                                                    |
| `report_received`        | —                                                                            | Xác nhận đã nhận báo cáo                                            |
| `app_error`              | `{ code, message }`                                                          | Lỗi (rate*limited, invalid*\*, banned, queue_full, server_error...) |

---

## 8. Frontend chi tiết — `public/`

### 8.1. `index.html`

Một trang đơn (SPA-lite) gồm ba "màn hình" chuyển đổi bằng class `.active`:

- **`#login-screen`** — biệt danh, ngôn ngữ ưu tiên, ô sở thích + các chip gợi ý, khối an toàn (18+ và Quy tắc), nút bắt đầu, nút quản lý người đã chặn.
- **`#waiting-screen`** — spinner, tiêu đề/mô tả trạng thái, dòng trạng thái hàng đợi.
- **`#chat-screen`** — header (tên đối phương, trạng thái, sở thích chung, nút Report/Block/Skip), panel icebreaker, khung tin nhắn, chỉ báo gõ, vùng nhập (nút emoji + ô nhập + nút gửi).

Hai `<dialog>`: `#report-dialog` (form báo cáo) và `#blocked-dialog` (danh sách người đã chặn). Hai nút nổi góc trên phải: đổi theme và đổi ngôn ngữ giao diện.

Thứ tự nạp script: `socket.io.js` → `i18n.js` → `script.js`.

### 8.2. `script.js`

Các nhóm logic chính:

- **Âm thanh** (`initAudio`, `playBeep`) — dùng Web Audio API tạo tiếng "ting" khi ghép và "pop" khi có tin (khởi tạo sau tương tác người dùng).
- **Danh tính & lưu trữ** — `getOrCreateClientId` (localStorage), `getBlockedPartners`/`saveBlockedPartners`, ghi nhớ xác nhận an toàn, theme, ngôn ngữ.
- **i18n bootstrap** — `t(key, params)`, áp dụng dịch tĩnh, nút đổi ngôn ngữ.
- **Sở thích** — chip bật/tắt đồng bộ với ô nhập (`getInterestTokens`, `syncInterestOptions`).
- **Quản lý màn hình** — `showScreen(id)` (đóng emoji panel khi rời màn chat).
- **Icebreaker** — `showIcebreakers` chọn câu mở lời theo ngôn ngữ ghép cặp và sở thích chung.
- **Theme** — `applyTheme` đặt `data-theme` trên `<html>`, đổi icon mặt trăng/mặt trời.
- **Emoji picker** — panel 70 emoji, chèn tại vị trí con trỏ, giới hạn 500 ký tự.
- **Reactions** — picker nổi cạnh tin nhắn, gửi `reactMessage`, gom đếm và render chip qua sự kiện `message_reaction`.
- **Thông báo** — xin quyền lúc login; `notify` chỉ bắn khi `document.hidden`. Khi người dùng không ở cuối khung chat, tin đến không kéo màn hình xuống mà tăng badge trên tab và hiện nút xem tin mới.
- **Đang nhập** — client tự gửi `stop_typing` khi xóa hết nội dung/gửi tin/rời chat; server chỉ relay lúc bắt đầu trạng thái gõ và tự hết hạn sau 3 giây để chỉ báo không bị kẹt.
- **Khôi phục kết nối** — Socket.IO tự thử lại khi mất mạng. Client hiển thị banner offline/reconnecting, giữ hồ sơ ẩn danh trong bộ nhớ, và gửi lại `login` sau khi nối lại. Vì room cũ không còn an toàn sau ngắt kết nối, người đang chat được thông báo kết thúc phiên và quay lại hàng đợi thay vì cố khôi phục room cũ.
- **Chặn trong chat** — nút Chặn mở `#block-dialog`; chỉ sau sự kiện `partner_blocked` từ server thì client mới lưu người bị chặn vào localStorage.
- **Vòng đời Socket.IO** — xử lý `connect`/`disconnect`/`connect_error`, các sự kiện server, gửi tin, gõ, skip, block, report.

Cờ trạng thái quan trọng: `hasActiveSession`, `isInChat`, `currentPartnerId`, `currentPartnerName`.

### 8.3. `i18n.js`

- Phơi ra global `window.I18N` với `t`, `applyStatic`, `setLang`, getter `lang`.
- Từ điển đầy đủ cho `en` và `vi` (chuỗi tĩnh, động, thông báo lỗi theo mã).
- Tự phát hiện ngôn ngữ từ `navigator.language`, ưu tiên giá trị đã lưu trong localStorage (`ghostchat-ui-lang`).
- `applyStatic()` dịch DOM qua thuộc tính `data-i18n` (textContent), `data-i18n-placeholder`, `data-i18n-title` (đặt cả `title` lẫn `aria-label`); cập nhật `document.documentElement.lang`.
- `t(key, params)` hỗ trợ nội suy `{name}`, `{count}`, `{seconds}`, `{interests}`; fallback sang `en` rồi sang chính `key` nếu thiếu.
- Lỗi từ server được dịch theo mã `err_<code>`; nếu không có bản dịch thì dùng message gốc của server.

> Lưu ý: giá trị `value` của các `<option>` lý do báo cáo giữ nguyên tiếng Anh (chỉ nhãn hiển thị được dịch) để log kiểm duyệt nhất quán. Icebreaker chọn ngôn ngữ theo ngôn ngữ ghép cặp, độc lập với ngôn ngữ giao diện.

### 8.4. `style.css`

- Hệ **biến CSS** trong `:root` (theme tối mặc định) và override trong `[data-theme="light"]`: màu nền, kính (glass), văn bản, accent, bề mặt (`--surface-soft`, `--surface-strong`, `--system-bg`), độ mờ orb.
- Biến `--app-height` lấy từ `visualViewport` giúp khung chat co đúng khi bàn phím điện thoại mở; composer luôn neo đáy vùng nhìn thấy và tự cuộn về tin mới nhất khi người dùng đang soạn.
- Hiệu ứng glassmorphism, orb nền động, animation chuyển màn hình, bong bóng tin nhắn, chỉ báo gõ.
- Style cho emoji picker, reaction picker/chip, nút theme, nút đổi ngôn ngữ, dialog, danh sách chặn.
- Responsive ở `@media (max-width: 768px)`: chat toàn màn hình, nút **Report / Block / Skip** thành vùng chạm lớn có nhãn, composer có safe-area và dialog safety dạng bottom sheet trên màn hình hẹp.

### 8.5. Trang kiểm duyệt — `admin.html` / `admin.js`

- Đăng nhập bằng tài khoản moderator; `ADMIN_TOKEN` chỉ dùng bootstrap/recovery và trình duyệt không lưu credential mà dùng cookie phiên `HttpOnly`.
- Tab **Team** chỉ hiện với admin để tạo account, đổi role/mật khẩu, và bật/tắt moderator.
- Tab **Settings** chỉ hiện với admin, cho phép thay đổi cooldown ghép lại sau `not_a_match`, ngưỡng auto-ban, và số ngày lưu transcript; thay đổi có hiệu lực ngay và được audit.
- Trên điện thoại, admin tab bar sticky cuộn ngang, form và hành động card xếp dọc để dễ thao tác một tay; cỡ chữ input tối thiểu 16px giúp tránh trình duyệt tự zoom.
- `viewer` chỉ đọc; `moderator` có thể xử lý report, gỡ ban, và xóa transcript; `admin` có toàn quyền.
- Dialog sau khi kết thúc chat cho phép chọn đánh giá, ghi chú tùy chọn, và với đánh giá không an toàn có thể tạo report + block gắn với transcript.
- Khi chọn `not_a_match`, người dùng có thể chọn nhanh một lý do: lệch ngôn ngữ, khác sở thích, cách trò chuyện không hợp, hoặc lý do khác. Lý do là tùy chọn, lưu cùng feedback và được tổng hợp trên Overview admin.
- Điểm ghép cặp mềm được tính từ phản hồi đối tác: cần ít nhất 2 lượt `positive`/`not_a_match`, giới hạn trong khoảng -5..5, và chỉ dùng để phá hòa trong cùng một tầng tương thích. Người mới hoặc chưa đủ dữ liệu giữ điểm trung lập; `unsafe` không tham gia xếp hạng.
- Có nút đăng xuất, tự khôi phục phiên khi tải lại, và tự yêu cầu đăng nhập lại khi phiên hết hạn.
- Liệt kê báo cáo, lọc theo trạng thái, mỗi báo cáo là một thẻ cho phép đổi `status` và ghi `moderationNote`, lưu qua `PATCH /api/admin/reports/:id`.
- Tab **Appeals** hiển thị hàng đợi khiếu nại, lý do và snapshot lệnh cấm, mở transcript/report liên quan,
  và cho moderator/admin nút **Approve & lift ban** hoặc **Reject appeal**.
- Khi có report hoặc appeal mới, dashboard nhận SSE, tăng badge trên tab tương ứng và tự tải lại danh sách
  đang mở; trạng thái kết nối live/reconnecting được hiển thị cạnh thông báo.
- Trang đặt `noindex, nofollow`.

---

## 9. Cấu hình (biến môi trường)

| Biến                      | Mặc định                  | Mục đích                                                                                                |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `3000`                    | Cổng HTTP và Socket.IO                                                                                  |
| `DATA_DIR`                | `./data`                  | Thư mục lưu báo cáo, appeal, lệnh cấm, transcript, tài khoản moderator, và audit log                    |
| `BACKUP_DIR`              | `./backups`               | Thư mục lưu snapshot JSON có timestamp khi chạy `npm run backup`                                        |
| `BACKUP_RETENTION`        | `14`                      | Số snapshot giữ lại tự động; `0` tắt dọn snapshot cũ                                                    |
| `BACKUP_INTERVAL_HOURS`   | `0`                       | Chu kỳ backup tự động khi server đang chạy; `0` tắt backup theo lịch                                    |
| `CHAT_RETENTION_DAYS`     | `30`                      | Giá trị retention ban đầu; `0`/số âm là lưu vô thời hạn, sau khi Settings được lưu thì Settings ưu tiên |
| `ADMIN_TOKEN`             | _(khuyến nghị bootstrap)_ | Token tạo admin đầu tiên và truy cập khẩn cấp server-to-server                                          |
| `ADMIN_SESSION_TTL_HOURS` | `8`                       | Thời gian sống phiên admin trong RAM (giờ)                                                              |
| `ADMIN_COOKIE_SECURE`     | `auto`                    | Ép cờ `Secure` cho cookie (`true`/`1`); tự bật trong HTTPS/production                                   |
| `REDIS_URL`               | _(tùy chọn)_              | Bật Redis adapter cho nhiều instance, vd `redis://localhost:6379`                                       |

Bật kiểm duyệt (PowerShell):

```powershell
$env:ADMIN_TOKEN = 'mot-chuoi-bi-mat-dai-va-ngau-nhien'
npm start
```

Mở `http://localhost:3000/admin`, nhập token bootstrap một lần để tạo tài khoản `admin` đầu tiên trong tab **Team**, sau đó dùng username/password cho các lần đăng nhập tiếp theo. Token được đổi thành cookie phiên; không dán token vào URL.

### Sao lưu dữ liệu

Chạy `npm run backup` để chụp toàn bộ file JSON trong `DATA_DIR`. Mỗi snapshot nằm trong thư mục timestamp dưới
`BACKUP_DIR`, kèm `manifest.json` ghi kích thước và SHA-256 của từng file. Snapshot được tạo trong thư mục tạm rồi
đổi tên hoàn tất; không đặt `BACKUP_DIR` bên trong `DATA_DIR`. Mặc định giữ 14 snapshot, có thể đổi bằng
`BACKUP_RETENTION` hoặc tham số `--keep`; đặt `BACKUP_RETENTION=0` để không tự dọn. Dữ liệu backup chưa mã hóa,
phải bảo vệ như `DATA_DIR` và sao chép thêm sang ổ đĩa độc lập. Đặt `BACKUP_INTERVAL_HOURS=24` để server tạo một
snapshot lúc khởi động rồi lặp lại mỗi 24 giờ; đặt `0` để chỉ backup thủ công.

Admin có tab **Backups** để xem các snapshot. Server kiểm tra lại kích thước, SHA-256 và JSON của từng file trước
khi đánh dấu snapshot là hợp lệ; snapshot lỗi vẫn được báo nhưng không thể khôi phục. Sau khi xem danh sách file,
admin phải gõ chính xác `RESTORE <tên-snapshot>` để xếp lịch khôi phục. App không thay dữ liệu khi đang chạy: lần
khởi động kế tiếp sẽ kiểm tra backup thêm lần nữa, tạo một safety backup của `DATA_DIR` hiện tại, rồi mới thay toàn
bộ file JSON. Có thể hủy lịch trên tab Backups trước khi restart. Nếu quản lý app bằng tiến trình riêng, dừng app
trước rồi chạy `npm run restore:pending` để áp dụng lịch khôi phục.

---

## 10. Chạy & phát triển

Yêu cầu Node.js >= 20.

```bash
npm ci            # cài dependencies theo lockfile
npm start         # chạy server tại http://localhost:3000
npm run dev       # chạy với --watch, tự khởi động lại khi sửa file
npm run start:staging  # chạy cấu hình staging từ .env.staging tại cổng 3100
npm run backup:staging # tạo backup thủ công theo cấu hình .env.staging
```

Mở `http://localhost:3000`. Để thử ghép cặp, mở hai tab/trình duyệt khác nhau (mỗi tab có `clientId` riêng nếu khác hồ sơ trình duyệt; cùng một trình duyệt sẽ dùng chung `clientId` nên không tự ghép với chính mình).

---

## 11. Kiểm thử

```bash
npm test          # chạy node --test trên thư mục test/
```

Bộ kiểm thử (`test/chat-server.test.js`) dùng `node:test` + `socket.io-client`, tạo server thật trên cổng ngẫu nhiên với `DATA_DIR` tạm thời. Các trường hợp đang có:

1. Ghép theo sở thích chung và chuyển tiếp tin nhắn.
2. Từ chối dữ liệu login sai mà không làm rớt kết nối.
3. Validate ngôn ngữ và chia sẻ ngôn ngữ khi ghép.
4. Phát `queue_status` cho người đang chờ.
5. Từ chối tin nhắn quá dài.
6. Rate limit khi gửi tin dồn dập.
7. Không ghép lại với người đã chặn.
8. Nhận báo cáo và ghi log kiểm duyệt có cấu trúc.
9. Lưu báo cáo và yêu cầu admin token để xem.
10. Tạo snapshot backup JSON và dọn snapshot cũ theo retention.

Tiện ích test: `waitForEvent`, `createTestServer`, `connectClient`, `login`.

> Hiện chưa có test cho các tính năng mới (reactions, auto-ban, ban bền vững, i18n, health). Đây là hướng bổ sung tốt.

---

## 12. Triển khai Docker

`Dockerfile` dùng `node:22-alpine`, cài dependencies production (`npm ci --omit=dev`), đặt `NODE_ENV=production`, `PORT=3000`, `DATA_DIR=/app/data`, mở cổng 3000 và khai báo volume `/app/data`.

```bash
docker build -t ghostchat .
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e ADMIN_TOKEN='mot-chuoi-bi-mat-dai-va-ngau-nhien' \
  -v ghostchat-data:/app/data \
  ghostchat
```

Mount volume tại `/app/data` để báo cáo và lệnh cấm tồn tại qua các lần redeploy. Nên đặt sau HTTPS (kết thúc TLS ở proxy/host).

> Vì cài `--omit=dev` và Redis nằm trong `optionalDependencies`, image vẫn chứa các gói Redis. Nếu muốn dùng nhiều instance với Redis, truyền thêm `-e REDIS_URL=...`.

### Chạy staging trực tiếp bằng Node

Staging không cần Docker. Sao chép `.env.staging.example` thành `.env.staging`, thay token và đường dẫn admin bí
mật, rồi chạy:

```powershell
Copy-Item .env.staging.example .env.staging
# Chỉnh .env.staging trước khi chạy.
npm run start:staging
```

Staging chạy tại `http://localhost:3100`, dùng thư mục `data-staging` và `backups-staging` riêng, đồng thời tự
backup lúc khởi động và mỗi 24 giờ. Dùng `npm run backup:staging` để chụp thủ công. Ví dụ local dùng
`NODE_ENV=staging` với HTTP; khi triển khai sau HTTPS hãy đổi thành `NODE_ENV=production`.

---

## 13. An toàn & kiểm duyệt

- **Chặn (block)** dùng `clientId` ngẫu nhiên lưu ở trình duyệt. ID bị chặn gửi lên server chỉ để tránh ghép lại. Xóa dữ liệu trình duyệt tạo ID mới — đây là tính năng an toàn cho người dùng, **không phải lệnh cấm cấp tài khoản**.
- **Xác nhận 18+** là tự cam kết, không xác minh danh tính/tuổi.
- **Báo cáo** được validate, lưu `data/reports.json` và ghi log có cấu trúc `REPORT {...}`. Trang `/admin` lọc và đánh dấu đã xem/đã xử lý.
- **Lọc từ ngữ xấu** che bằng `*` (mở rộng danh sách trong `index.js`). **Giới hạn link** chặn spam.
- **Tự động cấm**: client bị báo cáo đủ ngưỡng trong cửa sổ thời gian sẽ bị cấm tạm thời; lệnh cấm **lưu xuống đĩa** và nạp lại khi khởi động; lệnh hết hạn tự được dọn. Đây là biện pháp nhẹ, **không thay thế kiểm duyệt thủ công**.
- Chat được lưu dạng transcript đã che từ nhạy cảm trong `data/chats.json` theo thời hạn cấu hình; thư mục dữ liệu phải được bảo vệ.
- Phiên admin nằm trong RAM của từng instance. Khi chạy sau load balancer, định tuyến console về một instance hoặc dùng session store dùng chung.

Khuyến nghị production: HTTPS, rate limit ở tầng proxy/IP, công bố chính sách quyền riêng tư, giám sát log lỗi và báo cáo, bảo vệ `ADMIN_TOKEN`.

---

## 14. Lưu trữ dữ liệu

- `data/reports.json` — mảng báo cáo (mới nhất ở đầu).
- `data/bans.json` — mảng lệnh cấm còn hiệu lực `{ clientId, banUntil }`.
- `data/chats.json` — transcript chat đã che nội dung, tự dọn theo `data/settings.json` (hoặc giá trị khởi tạo `CHAT_RETENTION_DAYS`).
- `data/settings.json` — cấu hình runtime của admin: cooldown `not_a_match`, ngưỡng auto-ban, và thời hạn lưu transcript.
- `data/resolved-reports.json` và `data/moderation-log.json` — báo cáo đã xử lý và nhật ký thao tác moderator (kèm actor).
- `data/appeals.json` — các khiếu nại ban, snapshot lệnh cấm, trạng thái và quyết định moderator.
- `data/moderators.json` — tài khoản moderator, role, trạng thái, và hash mật khẩu salted `scrypt`; không commit hoặc chia sẻ file này.
- Các file ghi nguyên tử (`.tmp` + `rename`) và tuần tự hóa qua hàng đợi thao tác. Thư mục `data/` nằm trong `.gitignore`.

---

## 15. Mở rộng nhiều instance

Đặt `REDIS_URL` để gắn Socket.IO Redis adapter, giúp **phân phối sự kiện giữa các instance**. Hai gói `redis` và `@socket.io/redis-adapter` là optional, chỉ nạp khi cần; nếu kết nối thất bại lúc khởi động, app log lỗi và chạy chế độ một-instance.

Khi bật `REDIS_URL`, hàng đợi và phòng ghép cặp được chia sẻ qua Redis, nên không cần sticky session cho matchmaking. Lệnh cấm và phiên admin vẫn nằm trong RAM từng instance; với load balancer, định tuyến admin về một instance hoặc dùng kho phiên dùng chung.

---

## 16. Giới hạn đã biết & hướng phát triển

**Giới hạn hiện tại:**

- Lệnh cấm và phiên admin theo từng instance (xem mục 15).
- Đếm reaction cộng dồn mỗi lần bấm (không "toggle 1 lần/người").
- Danh sách từ cấm và ngưỡng auto-ban ở mức cơ bản, cần tinh chỉnh theo cộng đồng.
- Chưa có test cho các tính năng mới.

**Hướng phát triển gợi ý:**

- Centralize hàng đợi matchmaking vào Redis để ghép xuyên instance.
- Reaction kiểu toggle theo người dùng.
- Bổ sung test cho reactions, auto-ban, ban bền vững, i18n, `/health`.
- Lọc nội dung nâng cao, CAPTCHA/proof-of-work chống bot, rate limit theo IP.
- WebRTC video/voice; gửi ảnh có kiểm duyệt.

---

## 17. Khắc phục sự cố (FAQ)

- **Không ghép được khi mở hai tab cùng trình duyệt?** Cùng trình duyệt dùng chung `clientId`, mà `canMatch` cấm ghép cùng `clientId`. Dùng hai trình duyệt/hồ sơ khác nhau hoặc cửa sổ ẩn danh.
- **Trang `/admin` báo 503?** Chưa đặt `ADMIN_TOKEN`. Đặt biến môi trường rồi khởi động lại.
- **Log đầy lỗi `ECONNREFUSED ...:6379`?** `REDIS_URL` trỏ tới Redis không chạy. App vẫn hoạt động một-instance; bỏ `REDIS_URL` hoặc khởi động Redis.
- **Reaction/emoji không hiện?** Kiểm tra `i18n.js` và `script.js` được nạp đúng thứ tự; xem console trình duyệt.
- **Báo cáo/lệnh cấm mất sau redeploy Docker?** Chưa mount volume `/app/data`. Mount volume bền vững.
- **Thông báo trình duyệt không hiện?** Chỉ bắn khi tab ẩn và đã cấp quyền Notification; một số trình duyệt yêu cầu HTTPS.
