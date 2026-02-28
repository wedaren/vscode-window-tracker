/**
 * @docs WindowRecord
 * A minimal, serializable record representing a VS Code window/workspace.
 * Stored in tracker JSON files and consumed by the `DataManager`.
 */
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

/**
 * @docs WindowNode
 * UI-facing node used by the tree provider. Extends `WindowRecord` with
 * presentation fields such as `stableId`, `origin` and `relativeActive`.
 */
export interface WindowNode extends WindowRecord {
  type: 'window';
  stableId: string;
  origin: 'tracked' | 'saved';
  dirUri?: import('vscode').Uri;
  relativeActive: string;
  isSaved?: boolean;
}
