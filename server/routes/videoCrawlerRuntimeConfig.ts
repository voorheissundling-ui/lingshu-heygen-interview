import fs from 'node:fs';
import path from 'node:path';
import type { Platform } from '../types/index.js';

/** Runtime configuration for the local crawler; no network or provider request occurs here. */
export function crawlerProxyUrl(runtimeProxy: string, env: NodeJS.ProcessEnv = process.env): string {
  return runtimeProxy || env.CRAWLER_PROXY || crawlerProxyPool(env)[0] || '';
}

export function crawlerExecutionEnv(runtimeProxy: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.NODE_USE_ENV_PROXY;
  if (runtimeProxy) {
    env.CRAWLER_PROXY = runtimeProxy;
    env.HTTPS_PROXY = runtimeProxy;
    env.HTTP_PROXY = runtimeProxy;
    env.https_proxy = runtimeProxy;
    env.http_proxy = runtimeProxy;
  }
  return env;
}

export function cookiesBrowser(env: NodeJS.ProcessEnv = process.env): string {
  return env.YT_DLP_COOKIES_BROWSER?.split(',').map(browser => browser.trim()).find(Boolean) || 'safari';
}

export function cookieBrowsers(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.YT_DLP_COOKIES_BROWSER?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  const candidates = [...new Set([...configured, cookiesBrowser(env), 'safari', 'chrome', 'brave', 'edge', 'firefox'])];
  return candidates.filter(browser => browserCookiesLikelyAvailable(browser, env));
}

export function cookieFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.YT_DLP_COOKIE_FILES || env.YT_DLP_COOKIES_FILE || '')
    .split(',')
    .map(file => file.trim())
    .filter(file => file && fs.existsSync(file));
}

export function usesServerCookiesForCrawl(platform: Platform): boolean {
  return platform === 'youtube' || platform === 'tiktok';
}

export function crawlerProxyPool(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CRAWLER_PROXY_POOL || '')
    .split(',')
    .map(proxy => proxy.trim())
    .filter(Boolean);
}

export function selectCrawlerProxy(attemptNo: number, env: NodeJS.ProcessEnv = process.env): string {
  const pool = crawlerProxyPool(env);
  if (pool.length === 0) return env.CRAWLER_PROXY || '';
  return pool[(attemptNo - 1) % pool.length] || '';
}

export function redactProxy(proxy: string): string {
  try {
    const parsed = new URL(proxy);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return proxy.replace(/\/\/[^@]+@/, '//***@');
  }
}

export function browserUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRAWLER_USER_AGENT
    || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
}

export function browserCookiesLikelyAvailable(browser: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.HOME || '';
  if (!home) return true;
  const support = path.join(home, 'Library', 'Application Support');
  const normalized = browser.toLowerCase();
  if (normalized === 'safari') {
    return fs.existsSync(path.join(home, 'Library', 'Cookies', 'Cookies.binarycookies'));
  }
  const roots: Record<string, string> = {
    chrome: path.join(support, 'Google', 'Chrome'),
    brave: path.join(support, 'BraveSoftware', 'Brave-Browser'),
    edge: path.join(support, 'Microsoft Edge'),
    firefox: path.join(support, 'Firefox', 'Profiles'),
  };
  const root = roots[normalized];
  if (root) {
    try {
      return fs.readdirSync(root, { withFileTypes: true }).some(entry => entry.isDirectory() && (
        fs.existsSync(path.join(root, entry.name, normalized === 'firefox' ? 'cookies.sqlite' : 'Cookies'))
        || fs.existsSync(path.join(root, entry.name, 'Network', 'Cookies'))
      ));
    } catch { return false; }
  }
  return true;
}
