# 官方接口核对（2026-10-23）

这里只核对文档，不代表账号实测。

- [生成视频](https://developers.heygen.com/reference/create-video)：v3；文档描述Idempotency-Key在24小时内重放结果，不能替代本地持久身份与对未知请求的对账。
- [公共人物](https://developers.heygen.com/reference/list-avatar-looks)：ownership=public过滤预置人物；实际Key可用人物尚待验证。
- [公共声音](https://developers.heygen.com/reference/list-voices)：type=public；实际人物声音组合尚待验证。
- [账户](https://developers.heygen.com/reference/get-current-user)：包含计费类型、余额等；查余额不等于设置费用上限。账户返回和实际收费仍需测试。

TikTok参考链接的公开读取只返回验证页面，未取得可解码视频，不声称已看过。
