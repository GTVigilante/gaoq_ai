export interface CareerPosition {
  readonly id: string;
  readonly title: string;
  readonly department: string;
  readonly location: string;
  readonly headcount: number;
  readonly publishedAt: string;
}

export interface CareerPositionsResponse {
  readonly positions: readonly CareerPosition[];
  readonly source: 'erp' | 'preview';
}

export interface CareerApplicationResponse {
  readonly applicationId: string;
  readonly preview: boolean;
}
