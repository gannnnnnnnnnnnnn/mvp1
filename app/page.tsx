import { redirect } from "next/navigation";
import { readUploadManifest } from "@/lib/uploads/manifestStore";

export default async function HomePage() {
  try {
    const manifest = await readUploadManifest();
    const files = manifest.files || [];
    if (!files || files.length === 0) {
      redirect("/onboarding");
    }
    redirect("/phase3");
  } catch {
    // Fail-safe: if local upload state is unreadable, send user to onboarding.
    redirect("/onboarding");
  }
}
