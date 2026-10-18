import ProtectedRoute from "@/components/ProtectedRoute";

export default function ProjectsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ProtectedRoute>{children}</ProtectedRoute>;
}
