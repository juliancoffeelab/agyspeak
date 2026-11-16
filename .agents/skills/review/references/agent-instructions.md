# Agent instruction review

Use [writing-for-agents](../../writing-for-agents/SKILL.md) as the underlying
guidance. Assess each reviewed skill (including its references) or standalone
instruction document separately with these questions:

1. **Behavior:** Does it meaningfully improve what the agent does?
2. **Relevance:** Is it current and useful?
3. **Authority:** Does it belong here, with the right scope and permissions?
4. **Added knowledge:** Does it add something beyond defaults or easily inspected
   code/config?
5. **Trigger:** Will the agent reach it when needed, and only then?
6. **Actionability:** Are the instructions concrete enough to follow?
7. **Organization:** Are steps, references and conditional details placed sensibly?
8. **Completion:** Can the agent tell when it is done?
9. **Attention cost:** Does its value justify its length, duplication and maintenance?

Report a table with the nine questions as rows and each reviewed skill or document
as a separate column. Rate every cell **good / bad / irrelevant**, with a brief
reason for bad ratings. Turn bad ratings into actionable findings with a concrete
consequence, following the [review reporting guidance](../SKILL.md#report).

**Complete when:** the reported table covers every question for every reviewed
skill or document, and each bad rating has a supported finding or an explicitly
unresolved question.
