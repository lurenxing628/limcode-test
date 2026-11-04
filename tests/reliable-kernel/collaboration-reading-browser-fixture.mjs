import { createBrowserFixtureServer } from './browser-fixture-server.mjs';

/** Synthetic Host facts; the list, cards, controls, MessageItem and scrolling are production code. */
export async function createHistoryScrollFixture() {
  const fixture = String.raw`
    import { reactive, ref } from 'vue';
    import { createPinia } from 'pinia';
    import { useReliableKernelClientFeedStore } from '/src/stores/useReliableKernelClientFeedStore.ts';
    import { createReliablePresentationIndex } from '/src/domain/reliablePresentationIndex.ts';
    const parameters = new URLSearchParams(location.search);
    const searching = parameters.has('search');
    const realFeed = parameters.has('real-feed');
    const rows = (from, count) => Array.from({length:count}, (_, i) => ({id:'message-'+(from+i), seq:from+i, role:'user', content:{role:'user',parts:[{text:'message-'+(from+i)+' '+('delayed body ').repeat(120+i%3*20)}]}, createdAt:from+i, status:'completed', conversationId:'scroll-conversation'}));
    const initialRows = rows(101, Number(parameters.get('count') || 29));
    const initialCards = parameters.get('cards')?.split(',').map(Number) || [105];
    const records = (messages, cards) => ({Message:Object.fromEntries(messages.map(row=>[row.id,{id:row.id,conversation_id:'scroll-conversation',message_seq:String(row.seq)}])),
      CollaborationMessage:Object.fromEntries(cards.map(seq=>['card-'+seq,{id:'card-'+seq,message_seq:String(seq),mode:'message',text_preview:'card-'+seq}])),
      CollaborationMessageSourceLink:Object.fromEntries(cards.map(seq=>['source-'+seq,{id:'source-'+seq,message_id:'card-'+seq,conversation_id:'scroll-conversation',source_kind:'tool'}])),
      CollaborationMessageTargetLink:Object.fromEntries(cards.map(seq=>['target-'+seq,{id:'target-'+seq,message_id:'card-'+seq,conversation_id:'peer'}])),
      CollaborationSendTimelineLink:Object.fromEntries(cards.map(seq=>['position-'+seq,{id:'position-'+seq,message_id:'card-'+seq,conversation_id:'scroll-conversation',predecessor_message_id:'message-'+seq,predecessor_message_seq:String(seq),exchange_seq:String(seq)}]))});
    export const projection = ref({messages:initialRows,index:createReliablePresentationIndex(initialRows,[]),contentWindowByMessageId:{},splitSourceMessageIdByMessageId:{},absoluteFloorByMessageId:Object.fromEntries(initialRows.map(row=>[row.id,row.seq])), terminationByMessageId:{}, turnIdByMessageId:{}, interactionByToolCallId:{}, messageRevisionIdByMessageId:{}, modelRequestIdByMessageId:{}, toolCalls:[]});
    export const conversationId = ref('scroll-conversation');
    const requests = [], retainedCards = [];
    const syntheticFeed = reactive({records:{}, committedRecords:records(initialRows,initialCards), projections:{activeConversationWindow:{visibleMessageCount:'130'}}, details:{}, messageContentWindows:{}, transientModelRequests:{}, historyConversationId:'scroll-conversation', historyPages:[], historyCurrentPageId:null, historyHasMore:!searching, historyHasMoreAfter:false, historyLoading:false, historyLoadedPages:1,
      removedConversationIds:[],peerStateGeneration:0,acceptedAnswerPeerGenerations:{},collaborationHistoryConversationId:'scroll-conversation',collaborationHistoryHasMoreBefore:true,collaborationHistoryHasMoreAfter:searching,collaborationHistoryLoading:false,collaborationHistoryLoadedPages:1,collaborationHistoryScannedRows:0,collaborationHistoryError:null,
      requestEarlierHistory(){this.historyLoading=true;return true;},
      requestCollaborationHistoryPage(id,direction){requests.push({id,direction});this.collaborationHistoryLoading=true;this.collaborationHistoryError=null;return true;},
      retainCollaborationReadingPage(card){retainedCards.push(card.messageId);},retainReadingPage(){},retainMessageContentWindows(){},setPinnedDetailKeys(){},requestDetail(){},moveMessageContentWindow(){} });
    export const feed = realFeed ? useReliableKernelClientFeedStore(createPinia()) : syntheticFeed;
    export const useReliableConversation = () => ({feed, conversationId, projection, ensureDetails(){},completeMessageContent:async id=>projection.value.index.messageById.get(id).content});
    export const useChat = () => ({conversationAction:ref(null), conversationActionPending:ref(false), conversationActionLabel:ref(null), conversationActionNotice:ref(null), forkPendingTargetIds:ref(new Set()), currentAuthoritySelection:()=>({}), currentTurnInputEchoes:ref([])});
    export const useGlobalSettingsStore = () => ({llmProviderConfigs:{configs:[]},llm:{}});
    export const useSessionStore = () => ({runtimeError:null});
    export const useModelProfileStore = () => ({effectiveFor:()=>({})});
    export const useReliableTimelinePresentationStore = () => ({isSuppressed:()=>false});
    window.fixtureFeed = feed;
    window.fixtureRequests = requests;
    window.fixtureRetainedCards = retainedCards;
    if (realFeed) {
      Object.assign(feed, {
        sessionId: 'scroll-session',
        projections: { activeConversationWindow: { conversationId: 'scroll-conversation', visibleMessageCount: String(100 + initialRows.length) } },
        records: records(initialRows, []), committedRecords: records(initialRows, []),
        historyConversationId: 'scroll-conversation', historyLoadedPages: 1,
        collaborationHistoryConversationId: 'scroll-conversation', collaborationHistoryHasMoreBefore: true
      });
      const retain = feed.retainCollaborationReadingPage.bind(feed);
      feed.retainCollaborationReadingPage = card => { retainedCards.push(card.messageId); retain(card); };
      window.fulfillFeedHistory = (cards, { before, after, hasMoreBefore, hasMoreAfter }) => {
        const buckets = records([], cards);
        delete buckets.Message; // Message metadata belongs to the live window, not collaboration history.
        feed.observe({
          type: 'reliable-kernel.collaboration-history-result',
          sessionId: feed.sessionId, conversationId: 'scroll-conversation', requestId: feed.collaborationHistoryRequestId,
          page: {
            records: Object.fromEntries(Object.entries(buckets).map(([type, bucket]) => [type, Object.values(bucket)])),
            nextBeforeCursor: { kind: 'exchange', beforeExchangeSeq: String(before) },
            nextAfterCursor: { kind: 'exchange', afterExchangeSeq: String(after) },
            hasMoreBefore, hasMoreAfter,
            hasMore: feed.collaborationHistoryRequestDirection === 'before' ? hasMoreBefore : hasMoreAfter,
            scannedRows: Math.max(1, cards.length), scanProgress: cards.length === 0, responseBytes: 512
          }
        });
      };
      feed.requestEarlierCollaborationHistory('scroll-conversation');
      window.fulfillFeedHistory(initialCards, { before: Math.min(...initialCards), after: Math.max(...initialCards), hasMoreBefore: true, hasMoreAfter: true });
      window.fixtureInitialPageId = feed.collaborationHistoryCurrentPageId;
      requests.length = 0;
    }
    window.fulfillEarlier = () => {const messages=rows(81,50).map(row=>row.seq<101?{...row,content:{role:'user',parts:[]}}:row);projection.value={...projection.value,messages,index:createReliablePresentationIndex(messages,[],{},projection.value.index),absoluteFloorByMessageId:Object.fromEntries(messages.map(row=>[row.id,row.seq]))};feed.committedRecords=records(messages,[105]);feed.historyLoading=false;feed.historyLoadedPages++;};
    window.hydrateEarlier = () => {const messages=rows(81,50);projection.value={...projection.value,messages,index:createReliablePresentationIndex(messages,[],{},projection.value.index)};};
    window.fulfillCollaboration = () => {feed.committedRecords=records(projection.value.messages,[95,105]);feed.collaborationHistoryLoading=false;feed.collaborationHistoryHasMoreBefore=false;feed.collaborationHistoryLoadedPages++;};
    window.fulfillSearch = (cards, hasMore=false) => {feed.committedRecords=records(projection.value.messages,cards);feed.collaborationHistoryLoading=false;if(requests.at(-1)?.direction==='before')feed.collaborationHistoryHasMoreBefore=hasMore;else feed.collaborationHistoryHasMoreAfter=hasMore;feed.collaborationHistoryScannedRows+=cards.length;feed.collaborationHistoryLoadedPages++;};
    window.hydrateBefore = (target, repetitions=300) => {const messages=projection.value.messages.map(row=>row.seq<target?{...row,content:{role:'user',parts:[{text:('late expanded body ').repeat(repetitions)+row.id}]}}:row);projection.value={...projection.value,messages,index:createReliablePresentationIndex(messages,[],{},projection.value.index)};};
  `;
  const stubs = ['useSessionStore', 'useReliableConversation', 'useChat', 'useGlobalSettingsStore', 'useModelProfileStore', 'useReliableTimelinePresentationStore'];
  return createBrowserFixtureServer({
    dependencies: ['vue', 'pinia', '@tabler/icons-vue', 'markdown-it', 'markdown-it-texmath', 'katex'],
    plugins: [{
      name: 'history-scroll-browser-fixture', enforce: 'pre',
      resolveId(id) { if (id.startsWith('virtual:scroll-')) return '\0' + id; },
      load(id) {
        if (id === '\0virtual:scroll-fixture') return fixture;
        if (id === '\0virtual:scroll-body') return `import {h} from 'vue';export default {props:['card'],setup:p=>()=>p.card?h('div',p.card.messageId):null};`;
      },
      transform(code, id) {
        if (!id.endsWith('/ReliableMessageList.vue')) return;
        for (const hook of stubs) code = code.replace(new RegExp("from '(@webview/[^']+/" + hook + ")'", 'g'), "from 'virtual:scroll-fixture'");
        code = code.replace(/from '\.\/(?!MessageItem\.vue|ReliableCollaborationCard\.vue|ReliableCollaborationHistoryControls\.vue)[^']+\.vue'/g, "from 'virtual:scroll-body'");
        return code;
      },
      configureServer(vite) {
        vite.middlewares.use('/history-scroll-fixture', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/history-scroll-fixture', `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="app"></div><script type="module">
            import {createApp,h,ref} from 'vue'; import {createPinia} from 'pinia';
            import '/src/theme/tokens.css'; import '/src/theme/base.css';
            import '/src/theme/motion/message.css'; import '/src/theme/motion/content.css';
            import List from '/src/components/conversation/ReliableMessageList.vue';
            import {useBottomStickyScroller} from '/src/composables/useBottomStickyScroller.ts';
            const app=createApp({setup(){const scroller=ref(null);const sticky=useBottomStickyScroller(scroller);window.fixtureSticky=sticky;return()=>h('div',{id:'scroll-fixture',ref:scroller,tabindex:0,style:'width:640px;height:400px;overflow:auto;overflow-anchor:none'},[h(List,{scroller:scroller.value,followLatest:sticky.stickyToBottom.value})]);}}).use(createPinia());
            app.mount('#app');
          </script></body></html>`));
        });
      }
    }]
  });
}
