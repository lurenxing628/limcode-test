import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';

/** Deletion owns destination delivery settlement; immutable cross-Conversation message history remains. */
export async function collaborationConversationDeletionSteps(
  database: RuntimeDatabase,
  conversationIds: readonly string[]
): Promise<{ pendingDeliveryIds: Set<string>; steps: RepositoryTransactionStep[] }> {
  const steps: RepositoryTransactionStep[] = [];
  const pendingDeliveryIds = new Set<string>();
  const now = new Date().toISOString();
  const scopes: DomainRow[] = [];
  const authoredPosts: DomainRow[] = [];
  for (const conversationId of conversationIds) {
    const targets = await listAllDomainRows(database, 'CollaborationMessageTargetLink', { conversation_id: conversationId });
    steps.push(DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').assertExactIds(
      { conversation_id: conversationId }, targets.map(row => String(row.id))));
    // A pending request to a deleted target stays pending here. Collaboration reconcile settles it
    // once no Turn will answer it (its deliveries failed, or the Turn that took it in was deleted
    // here): a cross-conversation requester first hears why, a team request just fails.
    for (const target of targets) {
      const inboxId = String(target.inbox_item_id);
      const deliveries = await listAllDomainRows(database, 'RuntimeDelivery', { inbox_item_id: inboxId, target_conversation_id: conversationId });
      steps.push(DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(inboxId, {
        source_kind: 'collaboration_message', source_id: target.message_id
      }));
      steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assertExactIds(
        { inbox_item_id: inboxId, target_conversation_id: conversationId }, deliveries.map(row => String(row.id))));
      for (const delivery of deliveries) {
        const deliveryId = String(delivery.id);
        steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(deliveryId, {
          state: delivery.state, target_conversation_id: conversationId, updated_at: delivery.updated_at
        }));
        if (delivery.state === 'pending') {
          pendingDeliveryIds.add(deliveryId);
          steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(deliveryId, {
            state: 'failed', failure_reason: 'target-gone', updated_at: now
          }));
        }
        const wakes = await listAllDomainRows(database, 'RuntimeDeliveryWake', { delivery_id: deliveryId });
        steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').assertExactIds(
          { delivery_id: deliveryId }, wakes.map(row => String(row.id))));
        for (const wake of wakes) if (wake.state === 'pending' || wake.state === 'claimed') {
          steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').assert(String(wake.id), {
            state: wake.state, claim_generation: wake.claim_generation, updated_at: wake.updated_at
          }), DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').update(String(wake.id), {
            state: 'dead_letter', claim_owner_host_boot_id: null, claim_expires_at: null,
            next_attempt_at: null, last_error: 'target-gone', updated_at: now
          }));
        }
      }
    }
    const rootScopes = await listAllDomainRows(database, 'CollaborationBoardChannelScopeLink', { root_conversation_id: conversationId });
    scopes.push(...rootScopes);
    steps.push(DOMAIN_REPOSITORIES.domain('CollaborationBoardChannelScopeLink').assertExactIds(
      { root_conversation_id: conversationId }, rootScopes.map(row => String(row.id))));
    const sources = await listAllDomainRows(database, 'CollaborationBoardPostSourceLink', { conversation_id: conversationId });
    authoredPosts.push(...sources);
    steps.push(DOMAIN_REPOSITORIES.domain('CollaborationBoardPostSourceLink').assertExactIds(
      { conversation_id: conversationId }, sources.map(row => String(row.id))));
  }
  const postIds = new Set(authoredPosts.map(row => String(row.post_id)));
  const channelIds = new Set(scopes.map(row => String(row.channel_id)));
  for (const channelId of channelIds) {
    const members = await listAllDomainRows(database, 'CollaborationBoardPostChannelLink', { channel_id: channelId });
    steps.push(DOMAIN_REPOSITORIES.domain('CollaborationBoardPostChannelLink').assertExactIds(
      { channel_id: channelId }, members.map(row => String(row.id))));
    for (const member of members) postIds.add(String(member.post_id));
  }
  // Removing a thread also removes its replies; otherwise a surviving post loses its thread identity.
  for (const postId of postIds) {
    const replies = await listAllDomainRows(database, 'CollaborationBoardReplyLink', { thread_id: postId });
    steps.push(DOMAIN_REPOSITORIES.domain('CollaborationBoardReplyLink').assertExactIds(
      { thread_id: postId }, replies.map(row => String(row.id))));
    for (const reply of replies) postIds.add(String(reply.post_id));
  }
  for (const postId of postIds) steps.push(DOMAIN_REPOSITORIES.domain('CollaborationBoardPost').delete(postId));
  for (const channelId of channelIds) steps.push(DOMAIN_REPOSITORIES.domain('CollaborationBoardChannel').delete(channelId));
  return { pendingDeliveryIds, steps };
}
