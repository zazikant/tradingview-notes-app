import { ConvexHttpClient } from 'convex/browser';

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL || 'http://127.0.0.1:3210';

export const convexClient = new ConvexHttpClient(CONVEX_URL);

export interface Note {
  _id: string;
  ticker: string;
  body: string;
  tags: string[];
  created: number;
}

export interface Tag {
  _id: string;
  name: string;
  color: number;
}