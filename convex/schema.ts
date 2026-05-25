import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  notes: defineTable({
    clientId: v.string(),
    ticker: v.string(),
    body: v.string(),
    tags: v.array(v.string()),
    created: v.number(),
  }).searchIndex('clientId', { searchField: 'clientId' }),
  tags: defineTable({
    clientId: v.string(),
    name: v.string(),
    color: v.number(),
  }),
});