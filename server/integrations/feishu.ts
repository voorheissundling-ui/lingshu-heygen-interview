import axios from 'axios';

export interface FeishuConfig {
  webhookUrl: string;
  secret?: string;
}

import crypto from 'crypto';

function sign(secret: string, timestamp: string): string {
  const str = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', str).update('').digest('base64');
}

export async function sendFeishuText(config: FeishuConfig, content: string): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body: Record<string, unknown> = {
    msg_type: 'text',
    content: { text: content },
  };
  if (config.secret) {
    body.timestamp = timestamp;
    body.sign = sign(config.secret, timestamp);
  }
  await axios.post(config.webhookUrl, body);
}

export async function sendFeishuCard(
  config: FeishuConfig,
  title: string,
  content: string,
  color: 'blue' | 'green' | 'red' | 'yellow' = 'blue',
  actions: Array<{ text: string; url: string }> = [],
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body: Record<string, unknown> = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: title }, template: color },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content } },
        ...(actions.length ? [{
          tag: 'action',
          actions: actions.slice(0, 3).map(action => ({
            tag: 'button',
            text: { tag: 'plain_text', content: action.text },
            type: 'primary',
            url: action.url,
          })),
        }] : []),
      ],
    },
  };
  if (config.secret) {
    body.timestamp = timestamp;
    body.sign = sign(config.secret, timestamp);
  }
  await axios.post(config.webhookUrl, body);
}

export async function testFeishu(config: FeishuConfig): Promise<boolean> {
  try {
    await sendFeishuText(config, '【灵枢AI】消息渠道连接测试成功 ✅');
    return true;
  } catch {
    return false;
  }
}
