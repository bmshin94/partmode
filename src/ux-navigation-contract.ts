export type PartModeUxNavigationContext = 'first-visit' | 'existing-editor';

export interface PartModeUxNavigationStep {
  label: string;
  selector: string;
  interaction: 'click';
}

export interface PartModeUxNavigationPath {
  id: string;
  context: PartModeUxNavigationContext;
  goal: string;
  userPath: string;
  steps: readonly PartModeUxNavigationStep[];
}

export interface PartModeUxNavigationContract {
  schema: 'partmode.navigation/v1';
  paths: readonly PartModeUxNavigationPath[];
}

const path = (
  id: string,
  context: PartModeUxNavigationContext,
  goal: string,
  steps: readonly PartModeUxNavigationStep[],
): PartModeUxNavigationPath => Object.freeze({
  id,
  context,
  goal,
  userPath: steps.map((step) => step.label).join(' → '),
  steps: Object.freeze(steps.map((step) => Object.freeze({ ...step }))),
});

const click = (label: string, selector: string): PartModeUxNavigationStep => ({
  label,
  selector,
  interaction: 'click',
});

export const PARTMODE_UX_NAVIGATION_CONTRACT: PartModeUxNavigationContract = Object.freeze({
  schema: 'partmode.navigation/v1',
  paths: Object.freeze([
    path(
      'project.blank.first-visit',
      'first-visit',
      'Start a blank sketch',
      [click('Blank sketch', '#bw-welcome-start')],
    ),
    path(
      'templates.library.first-visit',
      'first-visit',
      'Open the template library',
      [click('Browse all templates', '#bw-welcome-templates')],
    ),
    path(
      'templates.library.existing-editor',
      'existing-editor',
      'Open the template library',
      [
        click('Home', '[data-workspace="home"]'),
        click('Template library', '[data-workspace-panel="home"] [data-command-target="bw-templates-open"]'),
      ],
    ),
    path(
      'templates.exploded-turbofan.first-visit',
      'first-visit',
      'Open the exploded turbofan assembly',
      [
        click('Browse all templates', '#bw-welcome-templates'),
        click('Exploded turbofan assembly', '[data-template-id="jet-engine-exploded-assembly"]'),
        click('Open editable template', '#bw-template-use'),
      ],
    ),
    path(
      'templates.exploded-turbofan.existing-editor',
      'existing-editor',
      'Open the exploded turbofan assembly',
      [
        click('Home', '[data-workspace="home"]'),
        click('Template library', '[data-workspace-panel="home"] [data-command-target="bw-templates-open"]'),
        click('Exploded turbofan assembly', '[data-template-id="jet-engine-exploded-assembly"]'),
        click('Open editable template', '#bw-template-use'),
      ],
    ),
    path(
      'templates.iso4017-screw.existing-editor',
      'existing-editor',
      'Open the configured ISO 4017 screw family',
      [
        click('Home', '[data-workspace="home"]'),
        click('Template library', '[data-workspace-panel="home"] [data-command-target="bw-templates-open"]'),
        click('Standard parts', '[data-template-category="Standard parts"]'),
        click('ISO 4017 hexagon head screw', '[data-template-id="iso4017-hex-screw"]'),
        click('Open editable template', '#bw-template-use'),
      ],
    ),
    path(
      'configurations.existing-editor',
      'existing-editor',
      'Open part configurations',
      [
        click('Manage', '[data-workspace="manage"]'),
        click('Configurations', '[data-workspace-panel="manage"] [data-command-target="bw-configurations-open"]'),
      ],
    ),
    path(
      'drawing.existing-editor',
      'existing-editor',
      'Export the active drawing',
      [
        click('Output', '[data-workspace="output"]'),
        click('Drawing', '[data-workspace-panel="output"] [data-command-target="bw-export-drawing"]'),
      ],
    ),
  ]),
});

const PATHS_BY_ID = new Map(
  PARTMODE_UX_NAVIGATION_CONTRACT.paths.map((entry) => [entry.id, entry]),
);

export function getPartModeUxNavigationPath(id: string): PartModeUxNavigationPath {
  const result = PATHS_BY_ID.get(id);
  if (!result) throw new Error(`unknown PartMode UX navigation path: ${id}`);
  return result;
}

export function renderPartModeUxNavigationPath(id: string): string {
  return getPartModeUxNavigationPath(id).steps
    .map((step) => `**${step.label}**`)
    .join(' → ');
}
