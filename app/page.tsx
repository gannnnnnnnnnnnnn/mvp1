import { redirect } from "next/navigation";
import { readIndex } from "@/lib/fileStore";

export default async function HomePage() {
  try {
    const files = await readIndex();
    if (!files || files.length === 0) {
      redirect("/onboarding");
    }
    redirect("/phase3");
  } catch {
    // Fail-safe: if local index is unreadable, send user to onboarding.
    redirect("/onboarding");
  }
}

