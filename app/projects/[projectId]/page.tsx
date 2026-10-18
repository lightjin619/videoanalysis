"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useProjects } from "@/hooks/useProjects";
import { useVideoAnalyses } from "@/hooks/useVideoAnalyses";

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const { projects, isLoaded: projectsLoaded } = useProjects();
  const { analyses, addAnalysis, deleteAnalysis, isLoaded: analysesLoaded } =
    useVideoAnalyses(params.projectId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const project = projects.find((item) => item.id === params.projectId);

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    const item = addAnalysis(name.trim(), description.trim());
    setName("");
    setDescription("");
    router.push(`/projects/${params.projectId}/analyses/${item.id}`);
  };

  const handleDelete = (analysisId: string, analysisName: string) => {
    const shouldDelete = window.confirm(
      `Delete "${analysisName}"? Its saved analysis results will also be deleted.`
    );
    if (shouldDelete) {
      deleteAnalysis(analysisId);
    }
  };

  if (!projectsLoaded || !analysesLoaded) {
    return <p className="page-status">Loading project.</p>;
  }
  if (!project) {
    return <p className="page-status">Project not found.</p>;
  }

  return (
    <div className="project-detail-page">
      <div className="page-heading">
        <div>
          <Link className="back-link" href="/projects">
            ← Project List
          </Link>
          <span className="section-kicker">PROJECT</span>
          <h1>{project.name}</h1>
          <p>{project.description || "Manage video analysis items."}</p>
        </div>
        <span className="analysis-badge">{analyses.length} analyses</span>
      </div>

      <section className="subject-analysis-nav">
        <Link
          className="subject-analysis-card within"
          href={`/projects/${params.projectId}/within-subject`}
        >
          <span className="section-kicker">SAME PARTICIPANT</span>
          <h2>Within-subject analysis</h2>
          <p>
            Compare PPG and HRV changes for one participant across conditions,
            interventions, and time.
          </p>
          <strong>Open analysis page →</strong>
        </Link>
        <Link
          className="subject-analysis-card between"
          href={`/projects/${params.projectId}/between-subject`}
        >
          <span className="section-kicker">MULTIPLE PARTICIPANTS</span>
          <h2>Between-subject analysis</h2>
          <p>Compare differences across multiple participants or groups.</p>
          <strong>Open analysis page →</strong>
        </Link>
      </section>

      <form className="analysis-create-form" onSubmit={handleCreate}>
        <div>
          <span className="section-kicker">NEW ANALYSIS</span>
          <h2>Add a Video Analysis Card</h2>
          <p>Analyze multiple videos separately within the same project.</p>
        </div>
        <div className="analysis-create-fields">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Analysis name (e.g., Resting State - Session 1)"
            required
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe the video or measurement conditions"
          />
          <button className="primary-button" type="submit">
            Create Analysis Card
          </button>
        </div>
      </form>

      <section className="analysis-items-section">
        <div className="section-heading-row">
          <div>
            <span className="section-kicker">VIDEO ANALYSES</span>
            <h2>Video Analyses</h2>
          </div>
        </div>

        <div className="analysis-item-grid">
          {analyses.map((analysis) => (
            <article
              className="analysis-item-card"
              key={analysis.id}
            >
              <button
                className="analysis-card-open"
                type="button"
                onClick={() =>
                  router.push(
                    `/projects/${params.projectId}/analyses/${analysis.id}`
                  )
                }
              >
                <span className="analysis-card-icon">▶</span>
                <span className="analysis-card-content">
                  <span className="analysis-card-title">{analysis.name}</span>
                  <span className="analysis-card-description">
                    {analysis.description || "No description"}
                  </span>
                  <time>{new Date(analysis.createdAt).toLocaleString()}</time>
                </span>
                <span className="analysis-card-action">Open analysis →</span>
              </button>
              <button
                className="analysis-card-delete"
                type="button"
                onClick={() => handleDelete(analysis.id, analysis.name)}
                aria-label={`Delete ${analysis.name}`}
              >
                Delete
              </button>
            </article>
          ))}
        </div>

        {analyses.length === 0 && (
          <div className="analysis-empty">
            <strong>No video analysis cards yet.</strong>
            <span>Create your first analysis card using the form above.</span>
          </div>
        )}
      </section>
    </div>
  );
}
