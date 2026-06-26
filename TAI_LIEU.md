# Tài liệu dự án GhostChat (anon-chat)

> Tài liệu kỹ thuật chi tiết cho ứng dụng trò chuyện ẩn danh 1-1 ghép cặp theo sở thích.

---

## 1. Giới thiệu tổng quan

**GhostChat** là một ứng dụng web cho phép hai người lạ trò chuyện ẩn danh theo thời gian thực, được ghép cặp dựa trên **sở thích chung** và **ngôn ngữ ưu tiên**. Ứng dụng:

- **Không tạo tài khoản**, không yêu cầu đăng nhập.
- **Không lưu lịch sử trò chuyện** — tin nhắn chỉ tồn tại trong phiên và được chuyển tiếp giữa hai người, không ghi vào ổ đĩa.
- Có cơ chế an toàn: chặn, báo cáo, lọc từ ngữ xấu, tự động cấm tạm thời, và một trang kiểm duyệt riêng.

Mỗi khách truy cập được gán một `clientId` ngẫu nhiên lưu trong trình duyệt (localStorage). Đây không phải tài khoản — xóa dữ liệu trình duyệt sẽ tạo `clientId` mới. `clientId` chỉ dùng để tránh ghép lại với người đã chặn và để gắn báo cáo/cấm.

---

## 2. Tính năng

| Nhóm | Tính năng |
| --- | --- |
| Ghép cặp | Ghép theo sở thích chung, ưu tiên ngôn ngữ tương thích (Việt/Anh/bất kỳ), fallback sau 10 giây chờ |
| Trò chuyện | Nhắn tin thời gian thực, chỉ báo "đang gõ", âm thanh thông báo |
| Gợi ý | Câu mở lời (icebreaker) theo sở thích chung và ngôn ngữ |
| Hàng đợi | Hiển thị số người đang chờ, ước tính thời gian chờ, số người trực tuyến |
| Cảm xúc | Emoji picker khi soạn tin; thả reaction emoji lên từng tin nhắn |
| Giao diện | Chuyển dark/light theme; đổi ngôn ngữ giao diện Việt/Anh (i18n) |
| Thông báo | Thông báo trình duyệt khi được ghép cặp hoặc có tin mới lúc tab ẩn |
| An toàn | Bỏ qua (skip), chặn (block), bỏ chặn, báo cáo với lý do |
| Kiểm duyệt | Lọc từ ngữ xấu, giới hạn link, tự động cấm theo số report; trang `/admin` |
| Vận hành | Endpoint `/health` với số liệu; ban lưu bền vững qua restart |
| Mở rộng | Redis adapter tùy chọn cho nhiều instance |

---

## 3. Công nghệ sử dụng

- **Node.js** (>= 20) — môi trường chạy.
- **Express 5** — phục vụ HTTP, file tĩnh và API admin.
- **Socket.IO 4** — giao tiếp thời gian thực hai chiều (WebSocket).
- **socket.io-client** — chỉ dùng cho bộ kiểm thử.
- **node:test** — bộ kiểm thử tích hợp sẵn của Node, không cần thư viện ngoài.
- **redis** + **@socket.io/redis-adapter** — *tùy chọn* (optionalDependencies), chỉ nạp khi bật `REDIS_URL`.
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
├── data/                     # Dữ liệu bền vững (gitignored): reports.json, bans.json
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
 └──────────────┘         │ reportStore / banStore (đĩa)   │      └──────────────┘
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

| Khóa | Giá trị | Ý nghĩa |
| --- | --- | --- |
| `maxUsernameLength` | 20 | Độ dài tối đa biệt danh |
| `maxInterestsInputLength` | 200 | Độ dài tối đa chuỗi sở thích nhập vào |
| `maxInterestLength` | 30 | Độ dài tối đa một sở thích |
| `maxInterests` | 10 | Số sở thích tối đa |
| `maxMessageLength` | 500 | Độ dài tối đa một tin nhắn |
| `maxReportReasonLength` | 300 | Độ dài tối đa lý do báo cáo |
| `maxBlockedClientIds` | 100 | Số người chặn tối đa gửi lên |
| `maxQueueSize` | 1000 | Sức chứa hàng đợi |
| `maxPayloadBytes` | 10000 | Kích thước payload Socket.IO tối đa |
| `messageRate` | 8 / 10s | Giới hạn gửi tin nhắn |
| `typingRate` | 1 / 750ms | Giới hạn sự kiện "đang gõ" |
| `skipRate` | 5 / 10s | Giới hạn bỏ qua |
| `reactionRate` | 15 / 10s | Giới hạn thả reaction |
| `loginRate` | 3 / 60s | Giới hạn đăng nhập |
| `blockRate` | 5 / 60s | Giới hạn chặn |
| `reportRate` | 3 / 60 phút | Giới hạn báo cáo |
| `maxLinksPerMessage` | 3 | Số link tối đa trong một tin nhắn |
| `autoBan` | ngưỡng 3, cửa sổ 60 phút, cấm 24 giờ | Tham số tự động cấm |

Các tập hợp/hằng khác:
- `COLORS` — bảng màu gán ngẫu nhiên cho mỗi socket (màu hiển thị tên).
- `REPORT_STATUSES` = `{new, reviewed, resolved}`.
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

### 6.5. Redis adapter (tùy chọn) — `setupRedisAdapter(io, redisUrl, logger)`

- Chỉ chạy khi có `redisUrl`. Nạp `redis` và `@socket.io/redis-adapter` theo kiểu **lazy require**.
- Tạo `pubClient`/`subClient`, gắn `io.adapter(createAdapter(...))` để sự kiện phân phối xuyên instance.
- **Chiến lược reconnect giới hạn**: thử lại tối đa 3 lần rồi báo lỗi và dừng, để startup thất bại nhanh khi Redis không sẵn sàng.
- **Fallback an toàn**: nếu lỗi, log rồi `return null`; server tiếp tục chạy chế độ một-instance. Client lỗi được `destroy()` an toàn để tránh reconnect nền gây spam log.

### 6.6. `createChatServer` — trạng thái và HTTP

Tham số: `{ logger, dataDir, adminToken, redisUrl }` (mặc định lấy từ biến môi trường).

**Trạng thái trong bộ nhớ:**
- `waitingQueue` — mảng các socket đang chờ ghép.
- `averageMatchWaitMs` — trung bình trượt thời gian chờ (EMA) để ước tính thời gian chờ.
- `totalMatches` — tổng số lần ghép (cho `/health`).
- `recentReportsByClient` — Map theo dõi mốc thời gian báo cáo theo `clientId`.
- `bannedClients` — Map `clientId -> banUntil`.

**Các route HTTP:**

| Method | Đường dẫn | Mô tả |
| --- | --- | --- |
| GET | `/health` | Công khai. Trả `status`, `uptimeSeconds`, `online`, `waiting`, `totalMatches`, `averageMatchWaitMs`, `activeBans` |
| GET | `/admin` | Trả trang `admin.html` |
| GET | `/api/admin/reports` | Yêu cầu admin. Liệt kê báo cáo, lọc theo `?status=` |
| PATCH | `/api/admin/reports/:id` | Yêu cầu admin. Cập nhật `status` + `moderationNote` |
| (static) | `/*` | Phục vụ thư mục `public/` |

**Xác thực admin:**
- `hasAdminAccess(request)` — đọc header `Authorization: Bearer <token>`, so sánh bằng `crypto.timingSafeEqual` (chống tấn công thời gian). Nếu chưa cấu hình `ADMIN_TOKEN` thì admin bị tắt (trả 503).
- `requireAdmin` — middleware chặn truy cập trái phép (401), đặt `Cache-Control: no-store`.
- `express.json({ limit: '5kb' })` giới hạn body API.

### 6.7. Thuật toán ghép cặp

Hàm `matchUsers()` chạy định kỳ mỗi 2 giây (`setInterval`, có `.unref()` để không giữ tiến trình sống) và cả khi có người mới vào hàng đợi.

Các bước:
1. **Dọn hàng đợi** — loại các socket đã ngắt kết nối, không còn ở trạng thái chờ, hoặc đã vào phòng.
2. **Quét cặp** — với mỗi `user1`, tìm `user2` tốt nhất qua `getBestMatchIndex` theo thứ tự ưu tiên:
   - (a) Có **sở thích chung** *và* **ngôn ngữ tương thích**.
   - (b) Có sở thích chung (bỏ qua ngôn ngữ).
   - (c) Ngôn ngữ tương thích *và* một trong hai đã chờ đủ **10 giây**.
   - (d) Bất kỳ ai (đã chờ đủ 10 giây) — fallback cuối.
3. **Điều kiện ghép** (`canMatch`): khác `clientId`, và **không bên nào đã chặn bên kia**.
4. **Tương thích ngôn ngữ** (`hasCompatibleLanguage`): một trong hai là `any`, hoặc cùng ngôn ngữ.
5. Khi ghép: tạo `roomId` (UUID), cả hai `join(roomId)`, gán `currentRoom` và `partner` cho nhau, phát `matched` kèm `sharedInterests`, tăng `totalMatches`, cập nhật EMA thời gian chờ.

`getQueueStatus()` trả `{ waitingCount, estimatedWaitSeconds, onlineCount }`. Ước tính thời gian chờ làm tròn theo bậc 5 giây, kẹp trong khoảng 5–120 giây. `broadcastQueueStatus()` phát `queue_status` cho tất cả.

### 6.8. Rate limiting

`isRateLimited(socket, key, { max, windowMs })` — lưu mốc thời gian theo từng `key` trên mỗi socket, lọc các mốc còn trong cửa sổ; nếu đạt `max` thì chặn. Áp dụng cho: login, message, typing, skip, block, report, reaction.

### 6.9. Lọc nội dung & tự động cấm

- Tin nhắn đi qua `parseMessage` → kiểm tra số link (`countLinks` vs `maxLinksPerMessage`) → `maskProfanity` trước khi phát trong room.
- `registerReportAgainst(clientId)` — ghi mốc báo cáo; nếu trong 60 phút đạt **3 báo cáo**, đặt lệnh cấm 24 giờ, lưu bền vững (`persistBans`), trả `true`.
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

| Sự kiện | Payload | Mô tả |
| --- | --- | --- |
| `login` | `{ username, interests, language, safetyAcknowledged, clientId, blockedClientIds }` | Vào hàng đợi sau khi validate |
| `chatMessage` | `string` | Gửi tin nhắn vào phòng hiện tại |
| `typing` | — | Báo đang gõ cho đối phương |
| `stop_typing` | — | Báo dừng gõ |
| `reactMessage` | `{ messageId, emoji }` | Thả reaction lên một tin nhắn |
| `skip` | — | Rời người hiện tại, tìm người mới |
| `blockPartner` | — | Chặn đối phương, tìm người mới |
| `reportPartner` | `{ reason }` | Báo cáo đối phương |

### 7.2. Server → Client

| Sự kiện | Payload | Mô tả |
| --- | --- | --- |
| `queued` | — | Đã vào hàng đợi |
| `queue_status` | `{ waitingCount, estimatedWaitSeconds, onlineCount }` | Cập nhật trạng thái hàng đợi |
| `matched` | `{ partnerName, partnerColor, partnerId, partnerLanguage, sharedInterests }` | Đã ghép cặp |
| `message` | `{ type, id, username, color, text, timestamp }` | Tin nhắn trong phòng |
| `typing` / `stop_typing` | — | Chỉ báo gõ của đối phương |
| `message_reaction` | `{ messageId, emoji, from }` | Reaction mới trên một tin nhắn |
| `partner_left` | — | Đối phương đã rời |
| `partner_blocked` | `{ partnerName, partnerId }` | Xác nhận đã chặn |
| `report_received` | — | Xác nhận đã nhận báo cáo |
| `app_error` | `{ code, message }` | Lỗi (rate_limited, invalid_*, banned, queue_full, server_error...) |

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
- **Thông báo** — xin quyền lúc login; `notify` chỉ bắn khi `document.hidden`.
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
- Hiệu ứng glassmorphism, orb nền động, animation chuyển màn hình, bong bóng tin nhắn, chỉ báo gõ.
- Style cho emoji picker, reaction picker/chip, nút theme, nút đổi ngôn ngữ, dialog, danh sách chặn.
- Responsive ở `@media (max-width: 768px)`: chat toàn màn hình, nút hành động thu gọn thành icon, điều chỉnh vị trí nút nổi và lưới emoji.

### 8.5. Trang kiểm duyệt — `admin.html` / `admin.js`

- Nhập `ADMIN_TOKEN`, lưu trong **sessionStorage** (chỉ phiên trình duyệt).
- Mọi request đính kèm header `Authorization: Bearer <token>`.
- Liệt kê báo cáo, lọc theo trạng thái, mỗi báo cáo là một thẻ cho phép đổi `status` và ghi `moderationNote`, lưu qua `PATCH /api/admin/reports/:id`.
- Trang đặt `noindex, nofollow`.

---

## 9. Cấu hình (biến môi trường)

| Biến | Mặc định | Mục đích |
| --- | --- | --- |
| `PORT` | `3000` | Cổng HTTP và Socket.IO |
| `DATA_DIR` | `./data` | Thư mục lưu báo cáo và lệnh cấm |
| `ADMIN_TOKEN` | _(bắt buộc để bật admin)_ | Token bảo vệ trang/API kiểm duyệt |
| `REDIS_URL` | _(tùy chọn)_ | Bật Redis adapter cho nhiều instance, vd `redis://localhost:6379` |

Bật kiểm duyệt (PowerShell):
```powershell
$env:ADMIN_TOKEN = 'mot-chuoi-bi-mat-dai-va-ngau-nhien'
npm start
```
Mở `http://localhost:3000/admin` và nhập đúng token.

---

## 10. Chạy & phát triển

Yêu cầu Node.js >= 20.

```bash
npm ci            # cài dependencies theo lockfile
npm start         # chạy server tại http://localhost:3000
npm run dev       # chạy với --watch, tự khởi động lại khi sửa file
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

---

## 13. An toàn & kiểm duyệt

- **Chặn (block)** dùng `clientId` ngẫu nhiên lưu ở trình duyệt. ID bị chặn gửi lên server chỉ để tránh ghép lại. Xóa dữ liệu trình duyệt tạo ID mới — đây là tính năng an toàn cho người dùng, **không phải lệnh cấm cấp tài khoản**.
- **Xác nhận 18+** là tự cam kết, không xác minh danh tính/tuổi.
- **Báo cáo** được validate, lưu `data/reports.json` và ghi log có cấu trúc `REPORT {...}`. Trang `/admin` lọc và đánh dấu đã xem/đã xử lý.
- **Lọc từ ngữ xấu** che bằng `*` (mở rộng danh sách trong `index.js`). **Giới hạn link** chặn spam.
- **Tự động cấm**: client bị báo cáo đủ ngưỡng trong cửa sổ thời gian sẽ bị cấm tạm thời; lệnh cấm **lưu xuống đĩa** và nạp lại khi khởi động; lệnh hết hạn tự được dọn. Đây là biện pháp nhẹ, **không thay thế kiểm duyệt thủ công**.
- Ứng dụng **cố ý không lưu tin nhắn**.

Khuyến nghị production: HTTPS, rate limit ở tầng proxy/IP, công bố chính sách quyền riêng tư, giám sát log lỗi và báo cáo, bảo vệ `ADMIN_TOKEN`.

---

## 14. Lưu trữ dữ liệu

- `data/reports.json` — mảng báo cáo (mới nhất ở đầu).
- `data/bans.json` — mảng lệnh cấm còn hiệu lực `{ clientId, banUntil }`.
- Cả hai ghi nguyên tử (`.tmp` + `rename`) và tuần tự hóa qua hàng đợi thao tác. Thư mục `data/` nằm trong `.gitignore`.

---

## 15. Mở rộng nhiều instance

Đặt `REDIS_URL` để gắn Socket.IO Redis adapter, giúp **phân phối sự kiện giữa các instance**. Hai gói `redis` và `@socket.io/redis-adapter` là optional, chỉ nạp khi cần; nếu kết nối thất bại lúc khởi động, app log lỗi và chạy chế độ một-instance.

**Giới hạn quan trọng:** hàng đợi ghép cặp, quan hệ đối phương, lệnh cấm và số người online vẫn nằm trong RAM của **từng instance**. Khi chạy nhiều instance sau load balancer, cần bật **sticky sessions** để mỗi khách ở yên một instance suốt phiên — khi đó mỗi instance ghép trong nhóm kết nối của riêng nó. Ghép trên toàn bộ pool (hàng đợi dùng chung trong Redis) và partner state xuyên instance là bước phát triển lớn hơn, xây trên nền adapter này.

---

## 16. Giới hạn đã biết & hướng phát triển

**Giới hạn hiện tại:**
- Trạng thái matchmaking/online theo từng instance (xem mục 15).
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
