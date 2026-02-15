import PlaygroundClient from "@/app/dev/playground/PlaygroundClient";
import { assertDevOnlyPage } from "@/lib/devOnly";

export default function DevPlaygroundPage() {
  assertDevOnlyPage();

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Dev Playground</h1>
          <p className="mt-1 text-sm text-slate-600">
            Statement parsing inspection tooling. Not part of product workflow.
          </p>
        </header>
        <PlaygroundClient />
      </div>
    </main>
  );
}

