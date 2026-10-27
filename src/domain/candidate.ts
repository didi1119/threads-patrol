import { z } from 'zod';
export const scoreSchema = z.object({ playability: z.number().int().min(0).max(5), bridge: z.number().int().min(0).max(5), mediaFit: z.number().int().min(0).max(5), timing: z.number().int().min(0).max(5), safety: z.number().int().min(0).max(5) });
export type Scores = z.infer<typeof scoreSchema>;
export function candidatePriority(scores: Scores) { const total = Object.values(scores).reduce((a, b) => a + b, 0); return { total, bucket: scores.safety <= 1 ? 'rejected' : total >= 18 ? 'recommended' : total >= 15 ? 'review' : 'low' }; }
export type SourceGuard = { kind: 'own-account' | 'missing-context' | 'sensitive'; reason: string };
/** Conservative exclusions are independent of model scores; ordinary daily conversation remains eligible. */
export function sourceReviewGuard(source: {author: string; text: string}): SourceGuard | null {
    if (['bfh9023','best_forest_house'].includes(source.author.replace(/^@/,'').toLowerCase())) return {kind:'own-account',reason:'自己的帳號，不列入海巡接話候選'};
    if (/^\d+\s*(?:s|m|h|d|w|秒|分鐘|小時|天|週|周)$/i.test(source.text.trim())) return {kind:'missing-context',reason:'只有時間標籤，缺少原帖文字情境'};
    if (/(?:自殺|性侵|仇恨|代孕|選舉|选举|總統|战争|戰爭|身材管理都不行|自私的人)/.test(source.text)) return {kind:'sensitive',reason:'涉及敏感議題或針對人的貶抑，不適合品牌幽默接話；已排除自動草稿與核准'};
    return null;
}
export function guardCandidate(candidate: Candidate): Candidate {
    const sourceGuard = sourceReviewGuard(candidate);
    if (!sourceGuard || candidate.status==='published') return {...candidate, sourceGuard:undefined};
    return {...candidate,sourceGuard,suggestedScores:{playability:0,bridge:0,mediaFit:0,timing:0,safety:sourceGuard.kind==='sensitive'?1:0},aiReason:sourceGuard.reason,drafts:['','','']};
}
export function publicUrl(value: string) { try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^\d/.test(h) || h.includes(':'))
        return false;
    return true;
}
catch {
    return false;
} }
export function threadsUrl(value: string) { if (!publicUrl(value))
    return false; const u = new URL(value); return ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'].includes(u.hostname) && /^\/@[^/]+\/post\/[A-Za-z0-9_-]+\/?$/.test(u.pathname); }
const text = (max: number) => z.string().trim().max(max).transform(v => v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''));
export const sourceSchema = z.object({ sourcePostId: text(160).pipe(z.string().min(1)), sourceUrl: z.string().max(2048).refine(threadsUrl, '請填 Threads 貼文網址'), author: text(160).default(''), text: text(5000).pipe(z.string().min(1)), observedAt: z.iso.datetime().optional(), expiresAt: z.iso.datetime().optional(), scores: scoreSchema.optional(), publicMetrics: z.object({ likes: z.number().int().min(0).nullable().optional(), replies: z.number().int().min(0).nullable().optional() }).optional() });
export const metricSchema = z.object({ views: z.number().int().min(0).max(1e10).nullable(), likes: z.number().int().min(0).max(1e10).nullable(), replies: z.number().int().min(0).max(1e10).nullable(), reposts: z.number().int().min(0).max(1e10).nullable(), source: z.literal('manual'), recordedAt: z.iso.datetime() });
export const mediaSchema = z.object({ title: text(200).pipe(z.string().min(1)), kind: z.enum(['image', 'video']), originalUrl: z.string().max(2048).refine(publicUrl, '只接受公開 HTTPS 網址'), thumbnailUrl: z.union([z.literal(''), z.string().max(2048).refine(v => publicUrl(v) || /^\/api\/media-files\/[A-Za-z0-9_.-]+$/.test(v))]).default(''), tags: z.array(text(40)).max(20).default([]), rights: z.enum(['approved', 'pending', 'forbidden']), rightsNote: text(1000).default(''), cooldownDays: z.number().int().min(0).max(365).default(7), maxUses30Days: z.number().int().min(1).max(100).default(3), sourcePostUrl: z.string().refine(threadsUrl).optional(), sourceCaption: text(5000).optional(), historicalLikes: z.number().int().nonnegative().nullable().optional(), historicalReplies: z.number().int().nonnegative().nullable().optional(), historicalSnapshotAt: z.iso.datetime().optional() });
export type Material = z.infer<typeof mediaSchema> & {
    id: string;
    version: number;
    usage: string[];
    observations?:{sourcePostUrl:string;caption:string;likes:number|null;replies:number|null}[];
};
export type Candidate = Omit<z.infer<typeof sourceSchema>,'scores'> & {
    id: string;
    status: string;
    version: number;
    createdAt: string;
    collectedAt?: string;
    updatedAt: string;
    expiresAt: string;
    scores: Scores | null;
    drafts: string[];
    draftEngine?: 'rule-based' | 'workers-ai';
    suggestedScores?: Scores;
    aiReason?: string;
    sourceGuard?: SourceGuard;
    selectedDraft: number;
    editedText: string;
    approval?:{mediaId:string|null;mediaVersion:number|null;mediaUrl:string|null;at:string}|null;
    sourceChangedAt?:string;
    mediaId: string | null;
    publication: {
        url: string;
        at: string;
    } | null;
    metrics: {
        '24'?: z.infer<typeof metricSchema>;
        '72'?: z.infer<typeof metricSchema>;
    };
};
export const aiResultSchema = z.object({ drafts: z.array(z.string().min(10).max(600)).length(3), suggestedScores: scoreSchema, reason: z.string().min(1).max(700) });
export function draftSuggestions(text: string) { const topic = text.replace(/\s+/g, ' ').slice(0, 65); return [`看到「${topic}」，忍不住想：有些日子，真的只想把通知關掉，讓腦袋去森林散個步。🌿`, `今天的心情有點像「${topic}」。成年人最想要的超能力，大概是讓時間慢下來五分鐘吧。`, `「${topic}」讓人很有共鳴。如果把今天的心情放進森林，你會選一陣風，還是一片安靜？`]; }
export function mediaEligible(m: Material, now = Date.now()) { if (m.rights !== 'approved')
    return false; const times = m.usage.map(s => Date.parse(s)); return !times.some(t => now - t < m.cooldownDays * 86400000) && times.filter(t => now - t < 30 * 86400000).length < m.maxUses30Days; }
export const transitions: Record<string, string[]> = { new: ['review', 'approved', 'skipped'], review: ['review', 'approved', 'skipped'], approved: ['approved', 'review', 'skipped', 'published'], skipped: ['review'], published: ['published'], expired: [] };
export function csvCell(value: unknown) { const s = String(value ?? ''); return '"' + (/^[\s]*[=+@-]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"'; }
