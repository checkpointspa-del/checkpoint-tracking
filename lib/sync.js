/**
 * Allineamento immediato di un fulfillment appena creato.
 *
 * Chiude una finestra cieca del flusso attuale:
 *
 *   LDV creata ──┬──────── ~2 ore ────────┬── Beestore crea il fulfillment
 *                │                         │
 *                └─ eventi ShippyPro ──────┘
 *                   scartati: su Shopify
 *                   il tracking non esiste
 *
 * ShippyPro invia solo l'ultimo evento per finestra di aggiornamento, quindi
 * ciò che accade in quelle due ore non torna più. Se il corriere ritira il
 * pacco in quel lasso, il cliente riceve l'email di spedizione e trova scritto
 * "Ordine in lavorazione" mentre il pacco è già in viaggio.
 *
 * Qui, alla creazione del fulfillment, chiediamo a ShippyPro lo stato corrente
 * e lo scriviamo. Una chiamata per fulfillment: è l'uso previsto di
 * GetTracking, non quello "bulk" che ShippyPro sconsiglia.
 */

import { getTracking, unwrapTracking, trackingHasEvents } from './shippypro.js';
import { mapShippyProStatus } from './status.js';
import { shouldWriteEvent, createFulfillmentEvent } from './orders.js';

/**
 * @returns {Promise<Array<{tracking: string, status?: string, esito: string}>>}
 */
export async function syncFulfillmentFromShippyPro(fulfillment, { dryRun = false } = {}) {
  if (!process.env.SHIPPYPRO_API_KEY) {
    return [{ tracking: '-', esito: 'SHIPPYPRO_API_KEY non configurato, allineamento saltato' }];
  }

  const numeri = [...new Set(fulfillment.trackingInfo.map((t) => t.number).filter(Boolean))];
  if (!numeri.length) return [{ tracking: '-', esito: 'nessun codice spedizione' }];

  const esiti = [];

  for (const numero of numeri) {
    try {
      const raw = await getTracking(numero);
      const evento = unwrapTracking(raw);

      if (dryRun) console.log('[sync] risposta GetTracking', numero, JSON.stringify(raw).slice(0, 1500));

      // Nessuna scansione del vettore: non c'è niente da scrivere.
      // Vedi trackingHasEvents(): senza questo controllo una LDV appena creata
      // verrebbe pubblicata come "Spedizione in ritardo".
      if (!trackingHasEvents(evento)) {
        esiti.push({ tracking: numero, esito: 'nessun evento dal vettore, niente da scrivere' });
        continue;
      }

      const { status, message } = mapShippyProStatus(evento);
      if (!status) {
        esiti.push({ tracking: numero, esito: 'stato ShippyPro non mappato' });
        continue;
      }

      const decisione = shouldWriteEvent(fulfillment, status, new Date().toISOString());
      if (!decisione.write) {
        esiti.push({ tracking: numero, status, esito: `no-op: ${decisione.reason}` });
        continue;
      }
      if (dryRun) {
        esiti.push({ tracking: numero, status, esito: 'DRY_RUN' });
        continue;
      }

      await createFulfillmentEvent({
        fulfillmentId: fulfillment.id,
        status,
        happenedAt: new Date().toISOString(),
        message: message || undefined,
      });
      esiti.push({ tracking: numero, status, esito: 'scritto' });
    } catch (err) {
      // Un fallimento qui non deve compromettere il webhook: l'URL di tracking
      // è già stato riscritto e gli eventi futuri arriveranno comunque.
      esiti.push({ tracking: numero, esito: `errore ShippyPro: ${err.message}` });
    }
  }

  return esiti;
}
