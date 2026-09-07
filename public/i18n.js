// Lightweight i18n for GhostChat. Exposes a global `I18N` helper used by script.js.
(function () {
  const LANG_KEY = 'ghostchat-ui-lang';

  const STRINGS = {
    en: {
      intro_kicker: 'A small room for big ideas',
      intro_heading: 'Meet someone outside your usual orbit.',
      intro_copy: 'Drop in, share what you are into, and let a better conversation find you.',
      intro_point_match: 'Instant one-on-one matching',
      intro_point_safe: 'Built-in safety controls',
      intro_point_private: 'No account required',
      subtitle: 'Enter your alias and choose a language to find a chat partner.',
      alias_placeholder: 'Your Alias...',
      lang_pref_label: 'Language preference',
      lang_any: 'Any language',
      interests_placeholder: 'Interests (e.g., anime, code, music)',
      interest_hint: 'Pick a few or type your own.',
      int_anime: 'Anime',
      int_music: 'Music',
      int_gaming: 'Gaming',
      int_movies: 'Movies',
      int_coding: 'Coding',
      int_travel: 'Travel',
      int_books: 'Books',
      int_fitness: 'Fitness',
      int_food: 'Food',
      int_art: 'Art',
      safety_title: 'A safer anonymous chat',
      safety_text:
        'Be kind. No harassment, scams, hate, or explicit content. Chats may be stored for moderator review, and reports are reviewed by moderators.',
      age_confirm: 'I confirm that I am 18 or older.',
      rules_confirm: 'I agree to follow the Community Rules.',
      start_btn: 'Start Chatting',
      manage_blocks: 'Manage blocked people',
      waiting_title: 'Looking for a partner...',
      waiting_detail: 'Please wait while we connect you to someone.',
      connected: 'Connected',
      report: 'Report',
      block: 'Block',
      skip: 'Skip',
      icebreaker_title: 'Break the ice',
      icebreaker_subtitle: 'Pick a prompt to get the conversation moving.',
      msg_placeholder: 'Type a mysterious message...',
      report_title: 'Report this person',
      report_desc: 'Your report is sent to the server log for moderator review.',
      report_reason_label: 'Reason',
      reason_harassment: 'Harassment or bullying',
      reason_hate: 'Hate or discrimination',
      reason_sexual: 'Sexual or explicit content',
      reason_spam: 'Spam or scam',
      reason_other: 'Other safety concern',
      report_note_label: 'Additional details (optional)',
      report_note_placeholder: 'Briefly describe what happened.',
      report_and_block: 'Block this person and find another match',
      cancel: 'Cancel',
      send_report: 'Send report',
      blocked_title: 'Blocked people',
      blocked_desc: 'Blocked people will not be matched with this browser again.',
      done: 'Done',
      unblock: 'Unblock',
      blocked_empty: 'You have not blocked anyone.',
      appeal_open: 'Banned? Submit an appeal',
      appeal_title: 'Appeal a chat restriction',
      appeal_desc:
        'Explain why you think the restriction should be reconsidered. A moderator will review the related case.',
      appeal_message_label: 'Your explanation',
      appeal_message_placeholder: 'Tell us what happened and why the ban should be reconsidered.',
      appeal_hint: 'Your anonymous session ID is attached automatically.',
      appeal_submit: 'Submit appeal',
      appeal_required: 'Write an explanation first.',
      appeal_sent: 'Your appeal was sent for moderator review.',
      appeal_pending: 'You already have a pending appeal for this restriction.',
      appeal_no_ban: 'No active ban was found for this browser.',
      appeal_failed: 'Could not submit your appeal. Please try again.',
      theme_toggle: 'Toggle light/dark theme',
      ui_lang_toggle: 'Switch interface language',

      connecting_title: 'Connecting...',
      connecting_detail: 'Please wait while we reach the chat server.',
      conn_problem_title: 'Connection problem',
      conn_problem_detail: 'We could not reach the chat server. Retrying...',
      reconnecting_title: 'Reconnecting...',
      reconnecting_detail: 'Your connection was interrupted. We will try again automatically.',
      unable_title: 'Unable to continue right now',
      finding_new_title: 'Looking for a partner...',
      finding_new_detail: 'Finding someone new for you.',
      blocked_finding_detail: 'The person was blocked. Finding someone new for you.',
      joining_queue: 'Joining the queue...',
      cancel_search: 'Cancel search',
      queue_none: 'No one else is searching right now.',
      queue_count: '{count} people are looking for a chat partner.',
      queue_wait: ' Typical wait: about {seconds} seconds.',
      queue_online: ' {count} online now.',
      connected_with: 'You have been connected with {name}.',
      both_like: ' You both like: {interests}.',
      say_hi: ' Say hi!',
      partner_left: 'Your partner has left the chat.',
      report_thanks: 'Your report was received. Thank you for helping keep GhostChat safer.',
      block_confirm: 'Block this person and find another match?',
      block_dialog_title: 'Block {name}?',
      block_dialog_desc:
        'This ends the chat and prevents this browser from matching with them again. You can undo it later from Blocked people.',
      block_and_find: 'Block and find someone else',
      blocking: 'Blocking...',
      partner_typing: '{name} is typing',
      new_messages: '{count} new message(s)',
      jump_to_latest: 'Jump to latest',
      feedback_title: 'How was that chat?',
      feedback_desc: 'A quick rating helps us make GhostChat safer and better.',
      feedback_positive: 'It was good',
      feedback_not_a_match: 'Not a good fit',
      feedback_unsafe: 'I felt unsafe',
      feedback_not_a_match_reason_title: 'What did not fit? (optional)',
      feedback_reason_language: 'Language did not match',
      feedback_reason_interests: 'Different interests',
      feedback_reason_style: 'Conversation style did not fit',
      feedback_reason_other: 'Something else',
      feedback_comment_label: 'Tell us more (optional)',
      feedback_comment_placeholder: 'What happened? This helps us improve.',
      feedback_send: 'Send feedback',
      feedback_skip: 'Skip for now',
      feedback_thanks: 'Thanks for your feedback.',
      feedback_choose_rating: 'Choose a rating first.',
      feedback_unsafe_report_reason: 'Safety concern after chat',
      feedback_unsafe_hint: 'You can report this person and block them to avoid matching again.',
      feedback_report_and_block: 'Report and block',
      need_safety: 'Confirm that you are 18+ and agree to the Community Rules first.',
      notify_matched: 'You matched with {name}. Say hi!',
      notify_message: 'Message from {name}',
      you: 'You',

      err_rate_limited: 'Please slow down a moment.',
      err_invalid_message: 'That message could not be sent.',
      err_invalid_report: 'That report could not be sent.',
      err_invalid_state: 'That action is not available right now.',
      err_banned:
        'You can no longer chat right now because of multiple reports. Please try again later.',
      err_queue_full: 'The chat is busy right now. Please try again shortly.',
      err_server_error: 'Something went wrong. Please try again.',
    },
    vi: {
      intro_kicker: 'Một góc nhỏ cho những ý tưởng lớn',
      intro_heading: 'Gặp một người mới, ngoài vùng quen thuộc.',
      intro_copy: 'Chia sẻ điều bạn thích, rồi để một cuộc trò chuyện thú vị tìm đến bạn.',
      intro_point_match: 'Ghép đôi trò chuyện tức thì',
      intro_point_safe: 'Tích hợp công cụ an toàn',
      intro_point_private: 'Không cần tạo tài khoản',
      subtitle: 'Nhập biệt danh và chọn ngôn ngữ để tìm người trò chuyện.',
      alias_placeholder: 'Biệt danh của bạn...',
      lang_pref_label: 'Ngôn ngữ ưu tiên',
      lang_any: 'Mọi ngôn ngữ',
      interests_placeholder: 'Sở thích (vd: anime, code, nhạc)',
      interest_hint: 'Chọn vài mục hoặc tự nhập.',
      int_anime: 'Anime',
      int_music: 'Âm nhạc',
      int_gaming: 'Game',
      int_movies: 'Phim',
      int_coding: 'Lập trình',
      int_travel: 'Du lịch',
      int_books: 'Sách',
      int_fitness: 'Thể hình',
      int_food: 'Ẩm thực',
      int_art: 'Nghệ thuật',
      safety_title: 'Trò chuyện ẩn danh an toàn hơn',
      safety_text:
        'Hãy tử tế. Không quấy rối, lừa đảo, thù ghét hay nội dung nhạy cảm. Cuộc trò chuyện có thể được lưu để kiểm duyệt viên xem xét, và báo cáo cũng sẽ được xem xét.',
      age_confirm: 'Tôi xác nhận mình từ 18 tuổi trở lên.',
      rules_confirm: 'Tôi đồng ý tuân theo Quy tắc Cộng đồng.',
      start_btn: 'Bắt đầu trò chuyện',
      manage_blocks: 'Quản lý người đã chặn',
      waiting_title: 'Đang tìm người trò chuyện...',
      waiting_detail: 'Vui lòng đợi trong khi chúng tôi kết nối bạn với ai đó.',
      connected: 'Đã kết nối',
      report: 'Báo cáo',
      block: 'Chặn',
      skip: 'Bỏ qua',
      icebreaker_title: 'Mở lời',
      icebreaker_subtitle: 'Chọn một gợi ý để bắt đầu câu chuyện.',
      msg_placeholder: 'Nhập một tin nhắn bí ẩn...',
      report_title: 'Báo cáo người này',
      report_desc: 'Báo cáo của bạn được ghi vào nhật ký máy chủ để kiểm duyệt viên xem xét.',
      report_reason_label: 'Lý do',
      reason_harassment: 'Quấy rối hoặc bắt nạt',
      reason_hate: 'Thù ghét hoặc phân biệt đối xử',
      reason_sexual: 'Nội dung tình dục hoặc nhạy cảm',
      reason_spam: 'Spam hoặc lừa đảo',
      reason_other: 'Vấn đề an toàn khác',
      report_note_label: 'Chi tiết thêm (tùy chọn)',
      report_note_placeholder: 'Mô tả ngắn gọn chuyện đã xảy ra.',
      report_and_block: 'Chặn người này và tìm người khác',
      cancel: 'Hủy',
      send_report: 'Gửi báo cáo',
      blocked_title: 'Người đã chặn',
      blocked_desc: 'Người đã chặn sẽ không được ghép lại với trình duyệt này.',
      done: 'Xong',
      unblock: 'Bỏ chặn',
      blocked_empty: 'Bạn chưa chặn ai.',
      appeal_open: 'Bị cấm? Gửi khiếu nại',
      appeal_title: 'Khiếu nại hạn chế trò chuyện',
      appeal_desc:
        'Giải thích vì sao bạn cho rằng hạn chế này cần được xem xét lại. Kiểm duyệt viên sẽ xem hồ sơ liên quan.',
      appeal_message_label: 'Lời giải thích của bạn',
      appeal_message_placeholder:
        'Hãy kể ngắn gọn chuyện đã xảy ra và vì sao bạn muốn được xem xét lại.',
      appeal_hint: 'Mã phiên ẩn danh của bạn được đính kèm tự động.',
      appeal_submit: 'Gửi khiếu nại',
      appeal_required: 'Hãy viết lời giải thích trước.',
      appeal_sent: 'Đã gửi khiếu nại để kiểm duyệt viên xem xét.',
      appeal_pending: 'Bạn đã có một khiếu nại đang chờ xử lý cho hạn chế này.',
      appeal_no_ban: 'Không tìm thấy lệnh cấm đang hoạt động trên trình duyệt này.',
      appeal_failed: 'Không thể gửi khiếu nại. Vui lòng thử lại.',
      theme_toggle: 'Đổi giao diện sáng/tối',
      ui_lang_toggle: 'Đổi ngôn ngữ giao diện',

      connecting_title: 'Đang kết nối...',
      connecting_detail: 'Vui lòng đợi trong khi chúng tôi kết nối tới máy chủ.',
      conn_problem_title: 'Sự cố kết nối',
      conn_problem_detail: 'Không thể kết nối tới máy chủ. Đang thử lại...',
      reconnecting_title: 'Đang kết nối lại...',
      reconnecting_detail: 'Kết nối bị gián đoạn. Chúng tôi sẽ tự động thử lại.',
      unable_title: 'Hiện chưa thể tiếp tục',
      finding_new_title: 'Đang tìm người trò chuyện...',
      finding_new_detail: 'Đang tìm người mới cho bạn.',
      blocked_finding_detail: 'Đã chặn người đó. Đang tìm người mới cho bạn.',
      joining_queue: 'Đang vào hàng đợi...',
      cancel_search: 'Hủy tìm kiếm',
      queue_none: 'Hiện chưa có ai khác đang tìm.',
      queue_count: '{count} người đang tìm bạn trò chuyện.',
      queue_wait: ' Thời gian chờ thường: khoảng {seconds} giây.',
      queue_online: ' {count} người đang trực tuyến.',
      connected_with: 'Bạn đã được kết nối với {name}.',
      both_like: ' Cả hai cùng thích: {interests}.',
      say_hi: ' Chào hỏi nào!',
      partner_left: 'Người trò chuyện đã rời đi.',
      report_thanks: 'Đã nhận báo cáo của bạn. Cảm ơn bạn đã giúp GhostChat an toàn hơn.',
      block_confirm: 'Chặn người này và tìm người khác?',
      block_dialog_title: 'Chặn {name}?',
      block_dialog_desc:
        'Thao tác này sẽ kết thúc cuộc trò chuyện và không ghép lại người này với trình duyệt của bạn. Bạn có thể bỏ chặn sau trong mục Người đã chặn.',
      block_and_find: 'Chặn và tìm người khác',
      blocking: 'Đang chặn...',
      partner_typing: '{name} đang nhập',
      new_messages: '{count} tin nhắn mới',
      jump_to_latest: 'Xem tin mới nhất',
      feedback_title: 'Cuộc trò chuyện vừa rồi thế nào?',
      feedback_desc: 'Đánh giá nhanh giúp GhostChat an toàn và phù hợp hơn.',
      feedback_positive: 'Ổn',
      feedback_not_a_match: 'Không phù hợp',
      feedback_unsafe: 'Tôi thấy không an toàn',
      feedback_not_a_match_reason_title: 'Điểm nào chưa phù hợp? (tùy chọn)',
      feedback_reason_language: 'Không hợp ngôn ngữ',
      feedback_reason_interests: 'Khác sở thích',
      feedback_reason_style: 'Cách trò chuyện không hợp',
      feedback_reason_other: 'Lý do khác',
      feedback_comment_label: 'Chia sẻ thêm (tùy chọn)',
      feedback_comment_placeholder: 'Chuyện gì đã xảy ra? Điều này giúp chúng tôi cải thiện.',
      feedback_send: 'Gửi đánh giá',
      feedback_skip: 'Bỏ qua',
      feedback_thanks: 'Cảm ơn bạn đã đánh giá.',
      feedback_choose_rating: 'Hãy chọn một mức đánh giá trước.',
      feedback_unsafe_report_reason: 'Lo ngại an toàn sau cuộc trò chuyện',
      feedback_unsafe_hint: 'Bạn có thể báo cáo và chặn người này để không bị ghép lại.',
      feedback_report_and_block: 'Báo cáo và chặn',
      need_safety: 'Hãy xác nhận bạn từ 18+ và đồng ý Quy tắc Cộng đồng trước.',
      notify_matched: 'Bạn đã ghép với {name}. Chào hỏi nào!',
      notify_message: 'Tin nhắn từ {name}',
      you: 'Bạn',

      err_rate_limited: 'Bạn thao tác hơi nhanh, chờ một chút nhé.',
      err_invalid_message: 'Không gửi được tin nhắn đó.',
      err_invalid_report: 'Không gửi được báo cáo đó.',
      err_invalid_state: 'Hành động này hiện không khả dụng.',
      err_banned:
        'Bạn tạm thời không thể trò chuyện do bị báo cáo nhiều lần. Vui lòng thử lại sau.',
      err_queue_full: 'Hệ thống đang bận. Vui lòng thử lại sau giây lát.',
      err_server_error: 'Có lỗi xảy ra. Vui lòng thử lại.',
    },
  };

  function detectInitialLang() {
    try {
      const saved = window.localStorage.getItem(LANG_KEY);
      if (saved === 'vi' || saved === 'en') return saved;
    } catch {
      // ignore
    }
    const browser = (navigator.language || '').toLowerCase();
    return browser.startsWith('vi') ? 'vi' : 'en';
  }

  let currentLang = detectInitialLang();

  function t(key, params) {
    const table = STRINGS[currentLang] || STRINGS.en;
    let value = table[key];
    if (value === undefined) value = STRINGS.en[key];
    if (value === undefined) return key;
    if (params) {
      value = value.replace(/\{(\w+)\}/g, (match, name) =>
        params[name] !== undefined ? params[name] : match,
      );
    }
    return value;
  }

  function applyStatic(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = t(element.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      element.setAttribute('placeholder', t(element.getAttribute('data-i18n-placeholder')));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((element) => {
      const text = t(element.getAttribute('data-i18n-title'));
      element.setAttribute('title', text);
      element.setAttribute('aria-label', text);
    });
    document.documentElement.lang = currentLang;
  }

  function setLang(lang) {
    if (lang !== 'vi' && lang !== 'en') return;
    currentLang = lang;
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch {
      // ignore
    }
    applyStatic();
    document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
  }

  window.I18N = {
    t,
    applyStatic,
    setLang,
    get lang() {
      return currentLang;
    },
  };
})();
