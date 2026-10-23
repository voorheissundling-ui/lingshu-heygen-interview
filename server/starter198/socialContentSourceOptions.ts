import type {
  SocialContentSourceOption,
  SocialContentSourceOptionPage,
} from '../../shared/contracts/socialContentWorkflow.js';
import { readMaterialLibrary, type MaterialRecord } from '../lib/materialLibrary.js';
import { dataBackend, store } from '../storage/index.js';
import { pbListStrict } from '../storage/pb.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';

export interface SocialContentSourceOptionsPort {
  list(input: {
    tenantId: string;
    kind?: SocialContentSourceOption['kind'];
    query?: string;
    page?: number;
    perPage?: number;
  }): Promise<SocialContentSourceOptionPage>;
  resolve(input: {
    tenantId: string;
    kind: SocialContentSourceOption['kind'];
    sourceRef: string;
  }): Promise<SocialContentSourceOption | null>;
}

function visibleText(value: unknown, fallback: string, maximum = 160): string {
  const parsed = socialText(value).replace(/[\u0000-\u001f]/g, ' ').slice(0, maximum);
  return parsed || fallback;
}

function safeThumbnail(value: unknown): string | null {
  const href = socialText(value);
  return /^\/(?:media|studio-media|api\/overseas\/studio\/materials\/pb)\//.test(href) ? href : null;
}

function materialOption(item: MaterialRecord): SocialContentSourceOption | null {
  const id = socialText(item.id);
  if (!id) return null;
  const encodedId = Buffer.from(id, 'utf8').toString('base64url');
  const sourceVersion = socialText(item.sourceRevision)
    || socialText(item.analysisSourceRevision)
    || socialText(item.sha256)
    || socialText(item.contentSha256)
    || socialRequestHash({ id, updatedAt: item.updatedAt ?? item.updated });
  return {
    optionId: `material:${encodedId}`,
    kind: 'material',
    sourceRef: `socialmaterial:${encodedId}`,
    sourceVersion: sourceVersion.slice(0, 100),
    label: visibleText(item.name ?? item.title ?? item.sourceName, '未命名素材'),
    type: visibleText(item.type, 'file', 40),
    thumbnailHref: safeThumbnail(item.poster),
  };
}

function productionEligibleMaterial(item: MaterialRecord, tenantId: string): boolean {
  if (!['video', 'image'].includes(socialText(item.type))) return false;
  return socialText(item.scope) === 'shared'
    || socialText(item.tenantId || item.tenant_id) === tenantId;
}

function profileFacts(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    company: socialObject(profile.company) ?? {},
    products: socialObject(profile.products) ?? {},
    brand: socialObject(profile.brand) ?? {},
    socialStrategy: profile.socialStrategy ?? null,
    strategy: profile.strategy ?? null,
    customers: profile.customers ?? null,
    operations: profile.operations ?? null,
    bizRules: profile.bizRules ?? null,
    faq: profile.faq ?? [],
    knowledge: socialText(profile.knowledge),
    savedAt: socialText(socialObject(profile.dataGovernance)?.lastSavedAt) || null,
  };
}

function recordValues(value: unknown): unknown[] {
  const record = socialObject(value);
  return record ? Object.values(record) : [];
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasKnowledge(profile: Record<string, unknown>): boolean {
  const company = socialObject(profile.company) ?? {};
  const products = socialObject(profile.products) ?? {};
  const brand = socialObject(profile.brand) ?? {};
  const dataGovernance = socialObject(profile.dataGovernance);
  const candidates: unknown[] = [
    ...Object.values(company),
    products.categories,
    products.priceRange,
    products.moq,
    products.certifications,
    products.highlights,
    ...array(products.items).flatMap(item => {
      const product = socialObject(item) ?? {};
      return [product.name, product.sku, product.category, product.highlights];
    }),
    ...Object.values(brand),
    ...recordValues(profile.customers),
    ...recordValues(profile.operations),
    profile.knowledge,
    ...array(profile.faq).flatMap(item => {
      const faq = socialObject(item) ?? {};
      return [faq.question, faq.answer];
    }),
  ];
  return dataGovernance?.aiAccessEnabled !== false && candidates.some(value => socialText(value));
}

function knowledgeOption(profile: Record<string, unknown>): SocialContentSourceOption | null {
  if (!hasKnowledge(profile)) return null;
  const facts = profileFacts(profile);
  const company = socialObject(profile.company) ?? {};
  const companyName = socialText(company.name);
  return {
    optionId: 'knowledge:enterprise-profile',
    kind: 'knowledge',
    sourceRef: 'socialknowledge:enterprise-profile',
    sourceVersion: socialRequestHash(facts),
    label: companyName ? `${visibleText(companyName, '企业')} · 企业知识` : '企业知识',
    type: 'enterprise_profile',
    thumbnailHref: null,
  };
}

function pocketBaseFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function readTenantKnowledgeProfile(tenantId: string): Promise<Record<string, unknown> | null> {
  const result = process.env.NODE_ENV === 'production' && dataBackend === 'pocketbase'
    ? await pbListStrict<Record<string, unknown> & { id: string }>('tenant_profiles', {
      filter: `tenant_id = ${pocketBaseFilterValue(tenantId)}`,
      page: 1,
      perPage: 2,
    })
    : await store.list<Record<string, unknown> & { id: string }>('tenant_profiles', {
      where: { tenant_id: tenantId }, page: 1, perPage: 2,
    });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_content_knowledge_integrity_violation', 503);
  }
  return socialObject(socialJson(result.items[0]?.profile));
}

async function allOptions(tenantId: string): Promise<{
  items: SocialContentSourceOption[];
  status: SocialContentSourceOptionPage['status'];
}> {
  const [materialsResult, profileResult] = await Promise.allSettled([
    readMaterialLibrary(tenantId),
    readTenantKnowledgeProfile(tenantId),
  ]);
  const materials = materialsResult.status === 'fulfilled'
    ? materialsResult.value.items
      .filter(item => productionEligibleMaterial(item, tenantId))
      .map(materialOption)
      .filter((item): item is SocialContentSourceOption => Boolean(item))
    : [];
  const knowledge = profileResult.status === 'fulfilled' && profileResult.value ? knowledgeOption(profileResult.value) : null;
  const readySources = Number(materialsResult.status === 'fulfilled' && materialsResult.value.status !== 'unavailable')
    + Number(profileResult.status === 'fulfilled');
  const status = readySources === 2 ? (materialsResult.status === 'fulfilled' && materialsResult.value.status === 'partial' ? 'partial' : 'ready')
    : readySources === 1 ? 'partial' : 'unavailable';
  return { items: [...(knowledge ? [knowledge] : []), ...materials], status };
}

async function list(input: Parameters<SocialContentSourceOptionsPort['list']>[0]): Promise<SocialContentSourceOptionPage> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const perPage = Math.min(50, Math.max(1, Math.floor(input.perPage ?? 20)));
  const query = socialText(input.query).toLocaleLowerCase().slice(0, 100);
  const all = await allOptions(input.tenantId);
  const items = all.items.filter(item => (!input.kind || item.kind === input.kind)
    && (!query || `${item.label} ${item.type}`.toLocaleLowerCase().includes(query)));
  const totalItems = items.length;
  return {
    items: items.slice((page - 1) * perPage, page * perPage),
    page,
    perPage,
    totalItems,
    totalPages: Math.ceil(totalItems / perPage),
    status: all.status,
  };
}

async function resolve(input: Parameters<SocialContentSourceOptionsPort['resolve']>[0]): Promise<SocialContentSourceOption | null> {
  const all = await allOptions(input.tenantId);
  if (all.status === 'unavailable') throw new SocialContentWorkflowError('social_content_source_catalog_unavailable', 503);
  return all.items.find(item => item.kind === input.kind && item.sourceRef === input.sourceRef) ?? null;
}

export const socialContentSourceOptions: SocialContentSourceOptionsPort = { list, resolve };
