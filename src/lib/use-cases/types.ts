export interface UseCaseCitation {
  label: string;
  url: string;
}

export interface UseCasePromptExample {
  title: string;
  prompt: string;
}

export interface UseCaseFAQ {
  question: string;
  answer: string;
}

export interface UseCaseAuthor {
  name: string;
  jobTitle: string;
  url: string;
}

export interface RedditEvidence {
  title: string;
  quote: string;
  url: string;
  score?: number;
  comments?: number;
}

export interface UseCase {
  slug: string;
  keyword: string;
  title: string;
  tagline: string;
  heroDescription: string;
  painPoints: string[];
  statInsight: string;
  citation: UseCaseCitation;
  promptExamples: UseCasePromptExample[];
  faqs: UseCaseFAQ[];
  author: UseCaseAuthor;
  relatedSlugs: string[];
  /** 最相关的行业枢纽 slug（/use-cases/<categorySlug>），用于面包屑与「所属行业」卡。 */
  categorySlug?: string;
  redditEvidence?: RedditEvidence[];
  workflowSteps?: string[];
  fitBoundary?: string;
  searchVariants?: string[];
}

