import { execFile } from 'node:child_process';
import path from 'node:path';
import { Router } from 'express';
import { QwenAsrService, qwenAsrCues } from './qwenAsr.js';

interface LocalAudio {
  bytes: Buffer;
  mimeType: string;
  filePath: string;
}

const qwenAsrService = new QwenAsrService(path.join(process.cwd(), 'data', 'qwen-asr'));

export function createStudioAsrRouter(loadAudio: (url: string) => LocalAudio | null, ffmpegBinary?: string | null) {
  const router = Router();
  router.post(['/asr', '/transcribe'], async (req, res) => {
    try {
      const duration = Number(req.body?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error('本版支持180秒以内音频');
      const media = loadAudio(String(req.body?.url || ''));
      if (!media) { res.status(404).json({ ok: false, error: '当前企业音频不存在' }); return; }
      if (req.body?.confirmed === true) {
        if (!ffmpegBinary) throw new Error('缺少音频时长检查工具，未提交付费转写');
        const actualDuration = await new Promise<number>((resolve, reject) => {
          execFile(ffmpegBinary, ['-hide_banner', '-i', media.filePath], { timeout: 10000, maxBuffer: 100000 }, (_error, _stdout, stderr) => {
            const match = String(stderr).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (!match) { reject(new Error('无法验证实际音频时长，未提交付费转写')); return; }
            resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
          });
        });
        if (actualDuration > 180 || Math.abs(actualDuration - duration) > 0.5) throw new Error('音频实际时长超限或与提交值不一致，未提交付费转写');
      }
      const task = await qwenAsrService.run(res.locals.tenantId, media.bytes, media.mimeType, req.body?.confirmed === true);
      const common = { id: task.id, taskId: task.taskId, status: task.status, error: task.error, usage: task.usage };
      if (task.status !== 'SUCCEEDED') { res.json({ ok: true, ...common }); return; }
      const result = qwenAsrCues(task.raw, duration, String(req.body?.text || req.body?.transcriptHint || '').slice(0, 6000));
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, ...common, ...result, source: 'qwen_asr' });
    } catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : '千问转写失败' }); }
  });
  return router;
}
