import { Check, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useGitSettings } from '../../../hooks/useGitSettings';
import { Button, Input } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import SettingsSection from '../../SettingsSection';

type IdentityFieldProps = {
  id: string;
  type: 'email' | 'text';
  value: string;
  placeholder: string;
  label: string;
  help: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
};

function IdentityField({
  id,
  type,
  value,
  placeholder,
  label,
  help,
  disabled,
  onValueChange,
}: IdentityFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-foreground">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={({ target }) => onValueChange(target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full"
      />
      <p className="mt-1 text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

export default function GitSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    gitName,
    setGitName,
    gitEmail,
    setGitEmail,
    isLoading,
    isSaving,
    saveStatus,
    saveGitConfig,
    githubToken,
    setGithubToken,
    githubConnected,
    githubSaving,
    githubStatus,
    saveGithubToken,
    removeGithubToken,
  } = useGitSettings();
  // `repo` is the narrowest scope that can read a private repository and push
  // to it; read-only scopes cannot make the commits the agents are asked to.
  const tokenCreateUrl = 'https://github.com/settings/tokens/new?description=gajae-code-app&scopes=repo';
  const isIdentityComplete = gitName.trim() !== '' && gitEmail.trim() !== '';
  const saveDisabled = isSaving || !isIdentityComplete;

  return (
    <div className="space-y-8">
      <SettingsSection title={t('git.title')} description={t('git.description')}>
        <SettingsCard className="p-4">
          <div className="space-y-4">
            <IdentityField
              id="settings-git-name"
              type="text"
              value={gitName}
              placeholder="John Doe"
              label={t('git.name.label')}
              help={t('git.name.help')}
              disabled={isLoading}
              onValueChange={setGitName}
            />
            <IdentityField
              id="settings-git-email"
              type="email"
              value={gitEmail}
              placeholder="john@example.com"
              label={t('git.email.label')}
              help={t('git.email.help')}
              disabled={isLoading}
              onValueChange={setGitEmail}
            />
            <div className="flex items-center gap-2">
              <Button onClick={saveGitConfig} disabled={saveDisabled}>
                {isSaving ? t('git.actions.saving') : t('git.actions.save')}
              </Button>
              {saveStatus === 'success' ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="h-4 w-4" />
                  {t('git.status.success')}
                </div>
              ) : null}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="GitHub access"
        description="A personal access token lets git, gh and the agents read private repositories and push commits. It is saved on the config volume and exported to the container environment."
      >
        <SettingsCard className="p-4">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={githubConnected ? 'text-foreground' : 'text-muted-foreground'}>
                {githubConnected ? 'A token is saved.' : 'No token saved.'}
              </span>
              <a
                href={tokenCreateUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Create a token on GitHub
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </div>
            <p className="text-xs text-muted-foreground">
              The link opens GitHub with the name gajae-code-app and the repo scope already filled in.
              That scope reads private repositories and pushes commits; narrow it if you only need public ones.
            </p>
            <div>
              <label htmlFor="settings-github-token" className="mb-2 block text-sm font-medium text-foreground">
                Personal access token
              </label>
              <Input
                id="settings-github-token"
                type="password"
                value={githubToken}
                onChange={({ target }) => setGithubToken(target.value)}
                placeholder={githubConnected ? 'Replace the saved token' : 'ghp_… or github_pat_…'}
                className="w-full"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void saveGithubToken()} disabled={githubSaving || githubToken.trim() === ''}>
                {githubSaving ? 'Saving…' : 'Save token'}
              </Button>
              {githubConnected ? (
                <Button variant="outline" onClick={() => void removeGithubToken()} disabled={githubSaving}>
                  Remove token
                </Button>
              ) : null}
              {githubStatus === 'success' ? (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="h-4 w-4" />
                  Saved
                </span>
              ) : null}
              {githubStatus === 'error' ? (
                <span className="text-sm text-destructive">That token was not accepted.</span>
              ) : null}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
