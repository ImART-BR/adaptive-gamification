/** A deck that has cards in today's queue. `pending` = still to study; `fresh` = never seen before. */
export interface DeckQueue {
  deckId: number;
  title: string;
  total: number;
  pending: number;
  fresh: number;
}

export interface QueueResponse {
  total: number;
  done: number;
  selected: { total: number; done: number };
  cards: QueueCard[];
}

export interface Home {
  user: { nickname: string; avatar: string; theme: string; frame: string };
  today: { queueTotal: number; queueDone: number; reviewsToday: number; decks: DeckQueue[] };
  points: { total: number; weekly: number };
  level: { level: number; into: number; needed: number };
  mastery: { deckId: number; title: string; cardCount: number; seen: number; mature: number; masteryPct: number }[];
  challenges: { key: string; title: string; reward: number; progress: number; target: number; claimed: boolean }[];
  achievements: { key: string; title: string; description: string; bonus: number; unlockedAt: number | null }[];
  leaderboard: { top: LeaderRow[]; me: LeaderRow | null; participants: number };
  cosmetics: {
    avatars: string[];
    themes: { key: string; label: string; level: number; unlocked: boolean }[];
    frames: { key: string; label: string; level: number; unlocked: boolean }[];
  };
  streakDays: number;
}

export interface LeaderRow {
  rank: number;
  nickname: string;
  avatar: string;
  frame: string;
  points: number;
  me: boolean;
}

export interface QueueCard {
  id: number;
  front: string;
  back: string;
  deckId: number;
  deckTitle: string;
  isNew: boolean;
}

export interface ReviewResult {
  grade: number;
  nextIntervalDays: number;
  pointsGained: number;
  queueDone: number;
  queueTotal: number;
  levelBefore: number;
  levelAfter: number;
  totalPoints: number;
  challengesDone: { key: string; title: string; reward: number }[];
  newAchievements: { key: string; title: string; bonus: number }[];
  pairBonus: number;
}

export interface CatalogDeck {
  id: number;
  title: string;
  description: string;
  owner: string | null;
  cardCount: number;
  inLibrary: boolean;
}

export interface PathInfo {
  key: string;
  title: string;
  description: string;
  decks: { id: number; title: string; inLibrary: boolean; cardCount: number; masteryPct: number }[];
}

// ---- slice 2 -----------------------------------------------------------------------------------------------

export interface PublicUser {
  handle: string;
  nickname: string;
  avatar: string;
  frame: string;
}

export interface GroupSummary {
  id: number;
  name: string;
  code: string;
  memberCount: number;
  weekReviews: number;
  weekGoal: number;
}

export interface GroupDetail {
  id: number;
  name: string;
  code: string;
  isOwner: boolean;
  weekReviews: number;
  weekGoal: number;
  members: (PublicUser & { weekPoints: number; weekReviews: number; me: boolean })[];
  decks: { id: number; title: string; cardCount: number; sharedBy: string | null; inLibrary: boolean }[];
}

export interface PairInfo {
  pair: null | {
    partner: PublicUser;
    partnerToday: { total: number; done: number } | null;
    myToday: { total: number; done: number } | null;
    bothDone: boolean;
    bonusToday: boolean;
    bonusPoints: number;
    since: number;
  };
  pendingInvite: string | null;
}

export interface GiftInfo {
  sentToday: number;
  remainingToday: number;
  receivedThisWeek: number;
  giftPoints: number;
}

export interface Impact {
  adopters: number;
  remixers: number;
  helpfulAnswers: number;
  giftsSent: number;
  giftsReceived: number;
  suggestionsAccepted: number;
  sharedDecks: number;
}

export interface SocialSummary {
  groups: GroupSummary[];
  pair: PairInfo;
  impact: Impact;
  gifts: GiftInfo;
  connections: PublicUser[];
  openQuestions: number;
}

export interface FeedItem {
  id: number;
  at: number;
  user: PublicUser;
  type: string;
  payload: Record<string, string | number | undefined>;
  toMe: boolean;
}

export interface Question {
  id: number;
  deckId: number;
  deckTitle: string;
  cardFront: string | null;
  text: string;
  at: number;
  user: PublicUser;
  mine: boolean;
  answered: boolean;
  answers: { id: number; text: string; at: number; user: PublicUser; helpful: boolean; mine: boolean }[];
}

export interface Proposals {
  votesLeft: number;
  maxVotes: number;
  proposals: { id: number; title: string; description: string; votes: number; voted: boolean; mine: boolean }[];
}

export interface Suggestion {
  id: number;
  cardId: number;
  deckId: number;
  deckTitle: string;
  currentFront: string;
  currentBack: string;
  newFront: string | null;
  newBack: string | null;
  note: string;
  status: string;
  at: number;
  user: PublicUser;
}

export interface DeckDetail {
  id: number;
  title: string;
  description: string;
  isPublic: boolean;
  mine: boolean;
  ownerNickname: string | null;
  inLibrary: boolean;
  sourceDeckId: number | null;
  cards: { id: number; front: string; back: string }[];
}
