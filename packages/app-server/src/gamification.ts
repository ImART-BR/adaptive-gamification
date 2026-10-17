// FIXED gamification rules of the static MVP. Every user sees the same elements the same way.
// With the experiment on, only the PROMINENCE of each element changes (decided by the core); these rules stay.

import type { Grade } from './srs.ts';

export const POINTS_PER_GRADE: Record<Grade, number> = { 0: 0, 1: 5, 2: 10, 3: 15 };

/** Levels: level n starts at 40*(n-1)^2 points. */
export function levelFromPoints(points: number): number {
  return 1 + Math.floor(Math.sqrt(Math.max(0, points) / 40));
}

export function levelProgress(points: number): { level: number; into: number; needed: number } {
  const level = levelFromPoints(points);
  const start = 40 * (level - 1) ** 2;
  const next = 40 * level ** 2;
  return { level, into: points - start, needed: next - start };
}

export const AVATARS = ['🐕', '🐶', '🦊', '🐱', '🐼', '🦉', '🐢', '🦄', '🐙', '🦁'] as const;

/** Cosmetic rewards unlocked by level. */
export const THEMES = [
  { key: 'padrao', label: 'Padrão', level: 1 },
  { key: 'noite', label: 'Noite', level: 2 },
  { key: 'floresta', label: 'Floresta', level: 4 },
  { key: 'sol', label: 'Sol', level: 6 },
] as const;

export const FRAMES = [
  { key: 'nenhuma', label: 'Sem moldura', level: 1 },
  { key: 'bronze', label: 'Moldura de bronze', level: 3 },
  { key: 'prata', label: 'Moldura de prata', level: 5 },
  { key: 'ouro', label: 'Moldura de ouro', level: 8 },
] as const;

export interface UserStats {
  totalReviews: number;
  streakDays: number;
  decksCreated: number;
  decksExplored: number;
  remixes: number;
  maxMasteryPct: number;
  perfectDays: number;
  level: number;
  // Slice 2 (social and community)
  groupsJoined: number;
  pairsFormed: number;
  decksShared: number;
  helpfulAnswers: number;
  giftsSent: number;
  votesCast: number;
  suggestionsAccepted: number;
  questionsAsked: number;
}

export interface AchievementDef {
  key: string;
  title: string;
  description: string;
  bonus: number;
  earned: (s: UserStats) => boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { key: 'first_review', title: 'Primeira revisão', description: 'Revise o seu primeiro cartão.', bonus: 10, earned: (s) => s.totalReviews >= 1 },
  { key: 'reviews_50', title: '50 revisões', description: 'Faça 50 revisões.', bonus: 25, earned: (s) => s.totalReviews >= 50 },
  { key: 'reviews_200', title: '200 revisões', description: 'Faça 200 revisões.', bonus: 50, earned: (s) => s.totalReviews >= 200 },
  { key: 'reviews_1000', title: '1000 revisões', description: 'Faça 1000 revisões.', bonus: 150, earned: (s) => s.totalReviews >= 1000 },
  { key: 'days_3', title: '3 dias seguidos', description: 'Estude em 3 dias seguidos.', bonus: 25, earned: (s) => s.streakDays >= 3 },
  { key: 'days_7', title: '7 dias seguidos', description: 'Estude em 7 dias seguidos.', bonus: 75, earned: (s) => s.streakDays >= 7 },
  { key: 'perfect_day', title: 'Dia completo', description: 'Conclua toda a fila do dia (com pelo menos 5 cartões).', bonus: 30, earned: (s) => s.perfectDays >= 1 },
  { key: 'deck_creator', title: 'Criador de baralhos', description: 'Crie um baralho.', bonus: 20, earned: (s) => s.decksCreated >= 1 },
  { key: 'remixer', title: 'Remixador', description: 'Faça um remix de um baralho público.', bonus: 20, earned: (s) => s.remixes >= 1 },
  { key: 'explorer', title: 'Explorador', description: 'Adicione um baralho do catálogo à sua biblioteca.', bonus: 15, earned: (s) => s.decksExplored >= 1 },
  { key: 'mastery_50', title: 'Domínio de 50%', description: 'Domine metade dos cartões de um baralho.', bonus: 60, earned: (s) => s.maxMasteryPct >= 50 },
  { key: 'level_5', title: 'Nível 5', description: 'Chegue ao nível 5.', bonus: 50, earned: (s) => s.level >= 5 },
  // Slice 2
  { key: 'group_member', title: 'Em grupo', description: 'Entre em um grupo de estudo ou crie um.', bonus: 15, earned: (s) => s.groupsJoined >= 1 },
  { key: 'pair_formed', title: 'Dupla formada', description: 'Forme uma dupla de estudo.', bonus: 15, earned: (s) => s.pairsFormed >= 1 },
  { key: 'sharer', title: 'Compartilhador', description: 'Publique ou compartilhe um baralho seu.', bonus: 20, earned: (s) => s.decksShared >= 1 },
  { key: 'curious', title: 'Curioso', description: 'Faça uma pergunta sobre um baralho.', bonus: 10, earned: (s) => s.questionsAsked >= 1 },
  { key: 'helper', title: 'Ajudante', description: 'Tenha uma resposta sua marcada como útil.', bonus: 30, earned: (s) => s.helpfulAnswers >= 1 },
  { key: 'generous', title: 'Generoso', description: 'Envie 5 presentes a colegas.', bonus: 25, earned: (s) => s.giftsSent >= 5 },
  { key: 'voter', title: 'Voz ativa', description: 'Vote em uma ideia de melhoria.', bonus: 10, earned: (s) => s.votesCast >= 1 },
  { key: 'editor', title: 'Editor', description: 'Tenha uma sugestão de edição aceita.', bonus: 30, earned: (s) => s.suggestionsAccepted >= 1 },
];

export interface TodayStats {
  reviewsToday: number;
  queueDone: number;
  queueTotal: number;
  /** Longest run of consecutive good/easy answers today. */
  bestRun: number;
}

export interface ChallengeDef {
  key: string;
  title: string;
  reward: number;
  target: (t: TodayStats) => number;
  progress: (t: TodayStats) => number;
}

/** The same three daily challenges for everyone. */
export const DAILY_CHALLENGES: ChallengeDef[] = [
  { key: 'daily_10', title: 'Revise 10 cartões', reward: 20, target: () => 10, progress: (t) => t.reviewsToday },
  { key: 'daily_run_5', title: 'Acerte 5 seguidos', reward: 20, target: () => 5, progress: (t) => t.bestRun },
  { key: 'daily_queue', title: 'Conclua a fila do dia', reward: 30, target: (t) => Math.max(1, t.queueTotal), progress: (t) => t.queueDone },
];

/** Ids of the game elements of the catalog (spec/catalog.flashcards.json) shown by this MVP slice. */
export const SLICE1_ELEMENTS = [
  'levels',
  'mastery_bar',
  'challenges',
  'achievements',
  'points',
  'leaderboard',
  'cosmetic_rewards',
  'explore_catalog',
  'nonlinear_paths',
  'avatar_theme',
  'create_remix_decks',
] as const;

/** The other 8 elements of the catalog, added in slice 2. */
export const SLICE2_ELEMENTS = ['study_groups', 'activity_feed', 'pair_study', 'share_decks', 'answer_peers', 'gifting', 'vote_features', 'suggest_edits'] as const;

export type ElementId = (typeof SLICE1_ELEMENTS)[number] | (typeof SLICE2_ELEMENTS)[number];

/** Gamification constants of the social features. */
export const SOCIAL = {
  maxGroupsPerUser: 5,
  maxGroupMembers: 20,
  groupWeeklyReviewsPerMember: 30,
  pairDailyBonus: 15,
  giftPoints: 5,
  giftsPerDay: 3,
  shareReward: 5,
  adoptedReward: 5,
  helpfulReward: 15,
  suggestionReward: 10,
  questionsPerDay: 5,
  answersPerDay: 20,
  maxVotes: 3,
  reportsToHide: 3,
  textMax: 500,
} as const;
