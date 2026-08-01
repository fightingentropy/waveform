import { Link, Navigate, useNavigate } from "react-router";
import { useRef, useState } from "react";
import { BarChart3, Camera, Loader2, LogOut, Settings } from "lucide-react";
import { useAuth } from "@/client/auth";
import { AccountAvatar } from "@/components/AuthButtons";

export default function ProfilePage() {
  const { user, status, signOut, updateProfileImage } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  if (status === "loading") {
    return (
      <div className="px-4 py-8 text-white sm:px-6 lg:px-10">
        <div className="opacity-70">Loading profile...</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/signin" replace />;

  const displayName = user.name || "Profile";

  async function handleProfileImageChange(file: File | undefined) {
    if (!file || uploadingImage) return;
    setUploadingImage(true);
    setImageError(null);
    try {
      await updateProfileImage(file);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "Failed to update profile image");
    } finally {
      setUploadingImage(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-5 border-b border-white/[0.1] pb-7">
          <div className="relative h-24 w-24 shrink-0">
            <AccountAvatar
              src={user.image}
              alt={displayName}
              className="h-24 w-24 rounded-full border border-white/[0.14] object-cover shadow-[0_16px_36px_rgba(0,0,0,0.35)]"
              iconSize={42}
            />
            <button
              type="button"
              aria-label="Change profile image"
              title="Change profile image"
              disabled={uploadingImage}
              onClick={() => fileInputRef.current?.click()}
              className="absolute bottom-0 right-0 grid h-9 w-9 place-items-center rounded-full border border-white/[0.18] bg-background text-white shadow-[0_8px_18px_rgba(0,0,0,0.35)] transition hover:bg-white/[0.1] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-wait disabled:opacity-70"
            >
              {uploadingImage ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              aria-label="Profile image file"
              className="sr-only"
              onChange={(event) => {
                void handleProfileImageChange(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-white/[0.48]">Profile</p>
            <h1 className="mt-1 truncate text-3xl font-semibold sm:text-4xl">{displayName}</h1>
            <p className="mt-2 truncate text-[15px] text-white/[0.64]">{user.email}</p>
            {imageError ? <p className="mt-2 text-sm text-red-300">{imageError}</p> : null}
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link
            to="/listening-stats"
            className="flex min-h-14 items-center gap-3 rounded-md border border-white/[0.12] px-4 text-white/[0.78] transition hover:bg-white/[0.07] hover:text-white"
          >
            <BarChart3 size={19} />
            <span>Listening stats</span>
          </Link>
          <Link
            to="/settings"
            className="flex min-h-14 items-center gap-3 rounded-md border border-white/[0.12] px-4 text-white/[0.78] transition hover:bg-white/[0.07] hover:text-white"
          >
            <Settings size={19} />
            <span>Settings</span>
          </Link>
          <button
            type="button"
            onClick={async () => {
              await signOut();
              navigate("/");
            }}
            className="flex min-h-14 items-center gap-3 rounded-md border border-white/[0.12] px-4 text-left text-white/[0.78] transition hover:bg-white/[0.07] hover:text-white"
          >
            <LogOut size={19} />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
