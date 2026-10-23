import axios from 'axios';
import crypto from 'crypto';

export interface DingTalkConfig {
  webhookUrl: string;
  secret?: string;
}

function sign(secret: string): { timestamp: string; sign: string } {
  const timestamp = Date.now().toString();
  const str = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(str).digest('base64');
  return { timestamp, sign: encodeURIComponent(sign) };
}

function buildUrl(config: DingTalkConfig): string {
  if (!config.secret) return config.webhookUrl;
  const { timestamp, sign: s } = sign(config.secret);
  return `${config.webhookUrl}&timestamp=${timestamp}&sign=${s}`;
}

export async function sendDingTalkText(config: DingTalkConfig, content: string, atMobiles: string[] = []): Promise<void> {
  await axios.post(buildUrl(config), {
    msgtype: 'text',
    text: { content },
    at: { atMobiles, isAtAll: false },
  });
}

export async function sendDingTalkMarkdown(config: DingTalkConfig, title: string, text: string): Promise<void> {
  await axios.post(buildUrl(config), {
    msgtype: 'markdown',
    markdown: { title, text },
  });
}

export async function testDingTalk(config: DingTalkConfig): Promise<boolean> {
  try {
    await sendDingTalkText(config, '【灵枢AI】消息渠道连接测试成功 ✅');
    return true;
  } catch {
    return false;
  }
}
