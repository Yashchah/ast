import * as vscode from 'vscode';
import { emptyLearner } from './learner';
import { Learner, Project } from './types';

const LEARNER_KEY = 'deliberate.learner.v1';
const PROJECT_KEY = 'deliberate.project.v1';

/**
 * Learner profile lives in globalState so knowledge carries across projects.
 * The project (goal, roadmap, task feed) lives in workspaceState.
 */
export class Store {
  learner: Learner;
  project: Project | undefined;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.learner = ctx.globalState.get<Learner>(LEARNER_KEY) ?? emptyLearner();
    this.project = ctx.workspaceState.get<Project>(PROJECT_KEY);
  }

  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.ctx.globalState.update(LEARNER_KEY, this.learner);
    await this.ctx.workspaceState.update(PROJECT_KEY, this.project);
  }

  async resetProject(): Promise<void> {
    this.project = undefined;
    await this.flush();
  }

  async resetLearner(): Promise<void> {
    this.learner = emptyLearner();
    await this.flush();
  }
}
