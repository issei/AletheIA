# Pull Request — AletheIA

> Preencha de forma objetiva. Comentários `<!-- ... -->` são dicas e podem ser removidos.

## 📝 Resumo

<!-- O que este PR faz? Por quê agora? Qual problema resolve? -->

## 🔄 Tipo de mudança

* [ ] `feat`: nova funcionalidade
* [ ] `fix`: correção de bug
* [ ] `refactor`: refatoração (sem mudança de comportamento)
* [ ] `perf`: melhoria de desempenho
* [ ] `test`: testes ou infraestrutura de teste
* [ ] `docs`: documentação
* [ ] `build/ci`: mudanças em build/CI
* [ ] `infra`: Terraform/infraestrutura
* [ ] `chore`: tarefas de manutenção

## 🧩 Escopo

**Serviços/partes afetadas**:

* [ ] `services/chat-stream`
* [ ] `services/ws-connection`
* [ ] `services/orchestration`
* [ ] `frontend/web`
* [ ] `infra/terraform`
* [ ] Outros: *especificar*

**Impacto de contrato** (APIs/WS/ASL/Schema DDB):

* [ ] Nenhum
* [ ] Sim (descreva a quebra/compatibilidade): *…*

## 🔗 Issues e tarefas

<!-- Relacione issues e tarefas do planejamento -->

Closes #\_\_\_\_
Relates #\_\_\_\_
Tarefas `/.planning/tasks.json`: `T-____`, `T-____`

## ✅ Evidências de teste

* [ ] Unit: `npm test`/`pytest`/`go test` **verde**
* [ ] Integração (WS/SFN/DDB): *descrever*
* [ ] E2E (opcional): *descrever*
* [ ] Cobertura ≥ **80%** no(s) pacote(s) afetado(s)
* Logs/prints relevantes (se UI, inclua screenshots/GIFs):

## 🔒 Segurança

* [ ] Sem inclusão de segredos no repositório
* [ ] IAM *least privilege* (anexe/resuma diff de políticas)
* [ ] PII tratada (hash+salt/encriptação/máscara)
* [ ] Rate limit/validação de payload (quando aplicável)

## 📊 Observabilidade & FinOps

* [ ] Logs JSON com `correlationId`/`messageId`
* [ ] Métricas EMF atualizadas (TTFT, erros, custo/conversa)
* [ ] Dashboards/Alarms ajustados (se aplicável)

## 🏗️ Terraform (se aplicável)

* [ ] `terraform fmt` / `validate` OK
* [ ] `terraform plan` executado
* **Resumo do plan** (cole os recursos principais ou anexe artefato):

```
<resumo do plan>
```

* [ ] Alteração **backward‑compatible**
* [ ] Plano de **rollback** descrito

## 🚀 Deploy & Rollback

Ambientes alvo: `dev` / `stg` / `prd`
Passos de deploy: *…*
**Rollback:** *como reverter rapidamente* (ex.: versão anterior/commit X, `terraform apply` com commit anterior, desfazer alias de Lambda, etc.)

## 📚 Documentação

* [ ] Atualizei `docs/` ou `kb/` (quando há mudança de contrato/fluxo)
* [ ] ADR criada/atualizada (se decisão arquitetural): `docs/architecture/decisões/ADR-xxxx.md`

## 🧭 Checklist final (DoD)

* [ ] CI **verde**: `ci.yml` e `security.yml`
* [ ] Cobertura ≥ 80% (onde aplicável)
* [ ] Sem *lint errors* / formatação padronizada
* [ ] Sem *TODOs* bloqueantes / *debug logs* deixados
* [ ] Planejamento sincronizado (`/.planning/tasks.json`)
* [ ] Revisão solicitada aos CODEOWNERS

---

### Notas para revisores

<!-- Ponto de entrada para validar rápido: comandos, URLs de teste, dados simulados, decisões importantes -->

### Rodapé (Conventional Commits)

<!-- Use quando aplicável -->

`BREAKING CHANGE:` *descreva a mudança incompatível*
`Co-authored-by:` *Nome <email>*
