-- Notícia manual (pedido do Terrani em 17/11/2026): novo tipo de fonte para o que o editor envia pelo painel.
-- Fica sozinho neste arquivo porque um valor novo de enum só pode ser usado depois do commit da transação
-- que o criou; a migration seguinte já cadastra a fonte com kind = 'manual'.

alter type source_kind add value if not exists 'manual';
