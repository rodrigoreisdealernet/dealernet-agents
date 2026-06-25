# Project board operations (via `gh`)

Canonical recipes for operating org **Project #15 "Dealernet ERP Factory"** (owner `Volaris-AI`,
id `PVT_kwDODKSoyc4BZ2Sp`) and the **Initiative → Epic → Story** sub-issue hierarchy
([ADR-0030](../adrs/0030-project-plan-initiative-epic-story-hierarchy.md)).

Agents perform these **directly with the `gh` CLI** (`gh project`, `gh issue`, and
`gh api graphql` for sub-issues). There is no wrapper script — introspect IDs at runtime and
run the commands. All examples use `--owner Volaris-AI` and repo `Volaris-AI/dia`.

> Single-select board fields: **Status** (Triage/Design/Todo/In Progress/Review/Ready for
> Release/Done/Blocked), **Queue Owner**, **Phase**, **Risk**, **Copilot Eligible**.

## Resolve project + field/option IDs (once per run)

```bash
PROJECT=15; OWNER=Volaris-AI; REPO=Volaris-AI/dia
PID=$(gh api graphql -f query='query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){id}}}' \
        -f o=$OWNER -F n=$PROJECT --jq '.data.organization.projectV2.id')   # PVT_kwDODKSoyc4BZ2Sp

# Field IDs + single-select option IDs (Status, Queue Owner, Phase, Risk, …)
gh project field-list $PROJECT --owner $OWNER --format json \
  | jq '.fields[] | {name, id, options: (.options // [] | map({name, id}))}'
```

## Add an issue to the board

```bash
gh project item-add $PROJECT --owner $OWNER --url https://github.com/$REPO/issues/<N> --format json
# → returns the project item {id}. To find an existing item's id later:
gh project item-list $PROJECT --owner $OWNER --format json --limit 1000 \
  | jq -r '.items[] | select(.content.number==<N>) | .id'
```

## Set a single-select field (Status / Queue Owner / Phase / Risk)

```bash
gh project item-edit --project-id "$PID" --id "<ITEM_ID>" \
  --field-id "<FIELD_ID>" --single-select-option-id "<OPTION_ID>"
```

## Link a native sub-issue (Initiative→Epic, Epic→Story)

A "Part of #N" text mention is **not** a hierarchy link — only `addSubIssue` is. Idempotent:
re-linking an existing child is a harmless no-op.

```bash
PARENT_ID=$(gh issue view <parent#> --repo $REPO --json id -q .id)
CHILD_ID=$(gh issue view <child#>  --repo $REPO --json id -q .id)
gh api graphql -H 'GraphQL-Features: sub_issues' \
  -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){subIssue{number}}}' \
  -f p="$PARENT_ID" -f c="$CHILD_ID"
```

## Inspect the hierarchy (find orphans)

```bash
# A story's current parent (null ⇒ orphan story); and an epic's children:
gh api graphql -H 'GraphQL-Features: sub_issues' \
  -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){
    parent{number title} subIssues(first:100){totalCount nodes{number title}} }}}' \
  -f o=$OWNER -f r=dia -F n=<N>

# Discover the standing levels (numbers change — never hard-code):
gh issue list --repo $REPO --state open --search 'Initiative: in:title' --json number,title
gh issue list --repo $REPO --state open --search 'Epic: in:title'       --json number,title
```

## Create a new Initiative or Epic (when nothing fits)

```bash
gh issue create --repo $REPO --title "Initiative: <theme>" \
  --body "**Initiative.** <one-paragraph outcome this groups.>" --label "queue:architecture"
gh issue create --repo $REPO --title "Epic: <capability>" \
  --body "**Epic.** <scope.>  Part of Initiative #<I>." --label "queue:architecture"
# then add to the board + link under its parent (above).
```

## Conventions

- **Initiatives** are open issues titled `Initiative: …`; **Epics** are titled `Epic: …`;
  everything else is a **Story**. Every Story is a sub-issue of exactly one Epic; every Epic
  is a sub-issue of exactly one Initiative.
- Don't force-fit: if an Epic genuinely fits no Initiative, create one — never leave it at top level.
- Add every open issue to the board before setting fields/links.
