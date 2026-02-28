export type WindowRecord = {
  title?: string;
  path?: string;
  uri?: string;
  pid?: number;
  windowId?: number | string;
  lastActive?: number;
  source?: string;
  status?: string;
};

export interface WindowNode extends WindowRecord {
  type: 'window';
  stableId: string;
  origin: 'tracked' | 'saved';
  dirUri?: import('vscode').Uri;
  relativeActive: string;
  isSaved?: boolean;
}
