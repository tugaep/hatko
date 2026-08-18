import { ApiKeyPanel } from '../api-key-panel.tsx';
import { ModelsPanel } from '../models-panel.tsx';

/**
 * Model configuration: the credential and the models it buys access to.
 *
 * One tab rather than two, because they are one decision — a hosted provider needs a key
 * and no installation, a local one needs an installation and no key, and an operator
 * choosing between them is choosing both at once. Splitting them would mean answering
 * half the question on each of two pages.
 */
export default function ModelsConfigurationPage() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <ApiKeyPanel />
      <ModelsPanel />
    </div>
  );
}
