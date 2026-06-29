/**
 * Registro de critérios de readiness — port 1:1 do "Agent Readiness Model" do
 * harness de referência (modelo de referência, 82 critérios). Fonte:
 * a referência
 *
 * Mantém id/name/category/level/scope/skippable VERBATIM. As `instructions` de
 * verificação (prosa pro auditor) NÃO vivem aqui — vivem no skill
 * (skills/harness-readiness-audit/criteria.json, cópia 1:1 do referência), igual ao
 * referência (registry `DK` em código + prompt do auditor com instructions).
 *
 * Adaptação LOCAL (a "small change" documentada em docs/02): `cloudOnly` marca
 * os critérios que só são verificáveis numa plataforma hospedada / API / runtime
 * (sem evidência num clone local) — DAST, PagerDuty, dashboards, GitHub API,
 * telemetria de deploy/observabilidade. Localmente o auditor emite `num=null`
 * pra eles (saem do score), além dos `skippable` do próprio referência.
 */

export type Category =
	| "build"
	| "style"
	| "security"
	| "debugging"
	| "docs"
	| "testing"
	| "dev_env"
	| "task_discovery"
	| "product";

export type Scope = "repository" | "application";

export interface Criterion {
	id: string;
	name: string;
	category: Category;
	level: number; // 1..5 — o tier que o critério representa
	scope: Scope;
	skippable: boolean; // isSkippable do referência (num pode ser null)
	cloudOnly: boolean; // adaptação local: não verificável num clone local → num=null
}

function c(
	id: string,
	name: string,
	category: Category,
	level: number,
	scope: Scope,
	skippable: boolean,
	cloudOnly = false,
): Criterion {
	return { id, name, category, level, scope, skippable, cloudOnly };
}

/** Os 82 critérios, agrupados por nível (port 1:1; `cloudOnly` é overlay local). */
export const READINESS_CRITERIA: readonly Criterion[] = [
	// ── Level 1 (7) ──────────────────────────────────────────────────────────
	c("env_template", "Environment Template", "dev_env", 1, "repository", false),
	c("readme", "README File", "docs", 1, "repository", false),
	c("gitignore_comprehensive", "Gitignore Comprehensive", "security", 1, "repository", false),
	c("formatter", "Code Formatter", "style", 1, "application", false),
	c("lint_config", "Linter Configuration", "style", 1, "application", false),
	c("type_check", "Type Checker", "style", 1, "application", false),
	c("unit_tests_exist", "Unit Tests Exist", "testing", 1, "application", false),
	// ── Level 2 (25) ─────────────────────────────────────────────────────────
	c("automated_pr_review", "Automated PR Review Generation", "build", 2, "repository", true, true),
	c("build_cmd_doc", "Build Command Documentation", "build", 2, "repository", false),
	c("deps_pinned", "Dependencies Pinned", "build", 2, "repository", false),
	c("monorepo_tooling", "Monorepo Tooling", "build", 2, "repository", true),
	c("vcs_cli_tools", "VCS CLI Tools", "build", 2, "repository", false),
	c("error_tracking_contextualized", "Error Tracking Contextualized", "debugging", 2, "application", false, true),
	c("runbooks_documented", "Runbooks Documented", "debugging", 2, "repository", false),
	c("structured_logging", "Structured Logging", "debugging", 2, "application", false),
	c("database_schema", "Database Schema", "dev_env", 2, "application", true),
	c("devcontainer", "Dev Container", "dev_env", 2, "repository", false),
	c("local_services_setup", "Local Services Setup", "dev_env", 2, "repository", true),
	c("agents_md", "AGENTS.md File", "docs", 2, "repository", false),
	c("automated_doc_generation", "Automated Documentation Generation", "docs", 2, "repository", false),
	c("automated_security_review", "Automated Security Review Generation", "security", 2, "repository", true),
	c("branch_protection", "Branch Protection", "security", 2, "repository", true, true),
	c("codeowners", "CODEOWNERS File", "security", 2, "repository", false),
	c("dependency_update_automation", "Dependency Update Automation", "security", 2, "repository", false),
	c("secrets_management", "Secrets Management", "security", 2, "repository", false),
	c("pre_commit_hooks", "Pre-commit Hooks", "style", 2, "application", false),
	c("strict_typing", "Strict Typing", "style", 2, "application", true),
	c("issue_labeling_system", "Issue Labeling System", "task_discovery", 2, "repository", false),
	c("issue_templates", "Issue Templates", "task_discovery", 2, "repository", false),
	c("pr_templates", "PR Templates", "task_discovery", 2, "repository", false),
	c("test_coverage_thresholds", "Test Coverage Thresholds", "testing", 2, "application", false),
	c("unit_tests_runnable", "Unit Tests Runnable", "testing", 2, "application", false),
	// ── Level 3 (28) ─────────────────────────────────────────────────────────
	c("agentic_development", "Agentic Development", "build", 3, "repository", false),
	c("dead_feature_flag_detection", "Dead Feature Flag Detection", "build", 3, "repository", true),
	c("release_automation", "Release Automation", "build", 3, "repository", false),
	c("release_notes_automation", "Release Notes Automation", "build", 3, "repository", false),
	c("single_command_setup", "Single Command Setup", "build", 3, "repository", false),
	c("unused_dependencies_detection", "Unused Dependencies Detection", "build", 3, "application", false),
	c("version_drift_detection", "Version Drift Detection", "build", 3, "repository", true),
	c("alerting_configured", "Alerting Configured", "debugging", 3, "application", false, true),
	c("distributed_tracing", "Distributed Tracing", "debugging", 3, "application", false, true),
	c("health_checks", "Health Checks", "debugging", 3, "application", true),
	c("metrics_collection", "Metrics Collection", "debugging", 3, "application", false, true),
	c("devcontainer_runnable", "Devcontainer Runnable", "dev_env", 3, "repository", true),
	c("api_schema_docs", "API Schema Docs", "docs", 3, "application", true),
	c("documentation_freshness", "Documentation Freshness", "docs", 3, "repository", false),
	c("service_flow_documented", "Service Architecture Documented", "docs", 3, "repository", false),
	c("skills", "Skills Configuration", "docs", 3, "repository", false),
	c("product_analytics_instrumentation", "Product Analytics Instrumentation", "product", 3, "application", false, true),
	c("log_scrubbing", "Sensitive Data Log Scrubbing", "security", 3, "application", false),
	c("min_release_age", "Minimum Dependency Release Age", "security", 3, "repository", false),
	c("pii_handling", "PII Handling", "security", 3, "application", true),
	c("secret_scanning", "Secret Scanning", "security", 3, "repository", true),
	c("dead_code_detection", "Dead Code Detection", "style", 3, "application", false),
	c("duplicate_code_detection", "Duplicate Code Detection", "style", 3, "application", false),
	c("large_file_detection", "Large File Detection", "style", 3, "repository", false),
	c("naming_consistency", "Naming Consistency", "style", 3, "application", false),
	c("tech_debt_tracking", "Technical Debt Tracking", "style", 3, "repository", false),
	c("integration_tests_exist", "Integration Tests Exist", "testing", 3, "application", false),
	c("test_naming_conventions", "Test File Naming Conventions", "testing", 3, "application", false),
	// ── Level 4 (20) ─────────────────────────────────────────────────────────
	c("build_performance_tracking", "Build Performance Tracking", "build", 4, "repository", true, true),
	c("deployment_frequency", "Deployment Frequency", "build", 4, "repository", true, true),
	c("fast_ci_feedback", "Fast CI Feedback", "build", 4, "repository", true, true),
	c("feature_flag_infrastructure", "Feature Flag Infrastructure", "build", 4, "repository", false),
	c("heavy_dependency_detection", "Heavy Dependency Detection", "build", 4, "application", true),
	c("progressive_rollout", "Progressive Rollout", "build", 4, "repository", true, true),
	c("rollback_automation", "Rollback Automation", "build", 4, "repository", true, true),
	c("circuit_breakers", "Circuit Breakers", "debugging", 4, "application", true, true),
	c("code_quality_metrics", "Code Quality Metrics Dashboard", "debugging", 4, "application", true, true),
	c("deployment_observability", "Deployment Observability", "debugging", 4, "application", false, true),
	c("profiling_instrumentation", "Profiling Instrumentation", "debugging", 4, "application", true, true),
	c("agents_md_validation", "AGENTS.md Freshness Validation", "docs", 4, "repository", false),
	c("dast_scanning", "DAST Scanning", "security", 4, "application", true, true),
	c("privacy_compliance", "Privacy Compliance", "security", 4, "repository", true, true),
	c("code_modularization", "Code Modularization Enforcement", "style", 4, "application", true),
	c("n_plus_one_detection", "N+1 Query Detection", "style", 4, "application", true),
	c("backlog_health", "Backlog Health", "task_discovery", 4, "repository", true, true),
	c("flaky_test_detection", "Flaky Test Detection", "testing", 4, "application", true),
	c("test_isolation", "Test Isolation", "testing", 4, "application", false),
	c("test_performance_tracking", "Test Performance Tracking", "testing", 4, "application", false),
	// ── Level 5 (2) ──────────────────────────────────────────────────────────
	c("error_to_insight_pipeline", "Error to Insight Pipeline", "product", 5, "application", false, true),
	c("cyclomatic_complexity", "Cyclomatic Complexity", "style", 5, "application", false),
];

/** Index id → critério. */
export const CRITERION_BY_ID: ReadonlyMap<string, Criterion> = new Map(READINESS_CRITERIA.map((x) => [x.id, x]));

/** Ids cloud-only (num=null forçado localmente). */
export const CLOUD_ONLY_IDS: readonly string[] = READINESS_CRITERIA.filter((x) => x.cloudOnly).map((x) => x.id);

/**
 * Um critério é "skippable localmente" se o referência já o marca skippable OU
 * se é cloudOnly (não verificável num clone). `num=null` só é válido nesses.
 */
export function isLocallySkippable(crit: Criterion): boolean {
	return crit.skippable || crit.cloudOnly;
}
