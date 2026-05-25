import { query, mutation } from 'convex/server';
import { v } from 'convex/values';

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('notes').collect();
  },
});

export const listTags = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('tags').collect();
  },
});

export const add = mutation({
  args: {
    clientId: v.string(),
    ticker: v.string(),
    body: v.string(),
    tags: v.array(v.string()),
    created: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('notes', args);
  },
});

export const update = mutation({
  args: {
    clientId: v.string(),
    ticker: v.string(),
    body: v.string(),
    tags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { clientId, ...updates } = args;
    const existing = await ctx.db.query('notes').collect();
    const doc = existing.find(n => n.clientId === clientId);
    if (doc) {
      await ctx.db.patch(doc._id, updates);
    }
  },
});

export const remove = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query('notes').collect();
    const doc = existing.find(n => n.clientId === args.clientId);
    if (doc) {
      await ctx.db.delete(doc._id);
    }
  },
});

export const addTag = mutation({
  args: { clientId: v.string(), name: v.string(), color: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert('tags', { clientId: args.clientId, name: args.name, color: args.color });
  },
});

export const updateTag = mutation({
  args: {
    clientId: v.string(),
    name: v.string(),
    color: v.number(),
  },
  handler: async (ctx, args) => {
    const { clientId, ...updates } = args;
    const existing = await ctx.db.query('tags').collect();
    const doc = existing.find(t => t.clientId === clientId);
    if (doc) {
      await ctx.db.patch(doc._id, updates);
    }
  },
});

export const removeTag = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query('tags').collect();
    const doc = existing.find(t => t.clientId === args.clientId);
    if (doc) {
      await ctx.db.delete(doc._id);
    }
  },
});

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query('notes').collect();
    if (existing.length > 0) return;

    const now = Date.now();
    const seedNotes = [
      { clientId: 'note_aapl', ticker: 'AAPL', body: 'Strong breakout above 180 resistance. Volume confirmed. Watch for retest of breakout level before entering. Target 195, stop below 178.', tags: ['tag_bull', 'tag_idea'], created: now - 86400000 * 2 },
      { clientId: 'note_tsla', ticker: 'TSLA', body: 'Bearish divergence on RSI at 4H. Price rejected at 240 for the third time. Looking for a break below 225 to short. Volume declining on up moves.', tags: ['tag_bear'], created: now - 86400000 },
      { clientId: 'note_nvda', ticker: 'NVDA', body: 'Earnings beat was massive. Holding position through the consolidation. AI tailwinds still strong. Will review after the next earnings cycle.', tags: ['tag_bull', 'tag_review'], created: now - 3600000 * 5 },
      { clientId: 'note_spy', ticker: 'SPY', body: 'Adding to watchlist ahead of FOMC. Key support at 430. If we hold this level, could see push to 450. Risk-off if we close below 425.', tags: ['tag_watch'], created: now - 3600000 * 2 },
      { clientId: 'note_meta', ticker: 'META', body: 'Cup and handle formation on the weekly. Breakout target ~340. Fundamentals improving — ad revenue bounce is real. Setting alert at 298.', tags: ['tag_bull', 'tag_idea', 'tag_watch'], created: now - 1800000 },
    ];

    for (const note of seedNotes) {
      await ctx.db.insert('notes', note);
    }

    const seedTags = [
      { clientId: 'tag_bull', name: 'Bullish', color: 0 },
      { clientId: 'tag_bear', name: 'Bearish', color: 1 },
      { clientId: 'tag_watch', name: 'Watchlist', color: 2 },
      { clientId: 'tag_idea', name: 'Trade idea', color: 3 },
      { clientId: 'tag_review', name: 'Review', color: 4 },
    ];

    for (const tag of seedTags) {
      await ctx.db.insert('tags', tag);
    }
  },
});