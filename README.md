# Check Point — Tracking

Due moduli indipendenti nello stesso progetto Vercel.

**A. Sincronizzazione** — ShippyPro invia i cambi di stato, l'app li scrive come
fulfillment event su Shopify. Nessun polling, nessun database: lo stato precedente
vive già nei fulfillment event di Shopify.

**B. Pagina tracking** — `/pages/tracking-area` legge solo ciò che il modulo A ha
già scritto su Shopify. Non interroga mai ShippyPro.

I due moduli non si conoscono. Il modulo A si disattiva togliendo il webhook su
ShippyPro; la pagina continua a funzionare mostrando l'ultimo stato noto.

AWS e Beestore non vengono toccati.

---

## Struttura

```
api/
  shippypro/tracking.js    webhook ShippyPro    -> scrive gli stati
  shopify/fulfillment.js   webhook Shopify      -> mantiene il link di tracking
  tracking.js              API pubblica         -> alimenta la pagina
lib/
  status.js                mapping ShippyPro -> Shopify + fasi cliente
  orders.js                lettura/scrittura ordini, regole di idempotenza
  carriers.js              ricostruzione URL corriere
  eta.js                   tag data prevista di spedizione
  tags.js                  convenzione tag ordine + protezione dati società
  token.js                 token HMAC + verifica webhook
  shippypro.js             client ShippyPro (solo backfill)
  shopify.js               client Admin GraphQL
scripts/
  test-permessi.mjs        DA ESEGUIRE PER PRIMO
  test-tags.mjs            verifica che nessun tag esca verso il browser
  setup-webhooks.mjs       registra i webhook Shopify via API
  rewrite-urls.mjs         riscrittura link, una tantum
  backfill.mjs             sincronizzazione iniziale, una tantum
  build-preview.mjs        rigenera l'anteprima locale
shopify/
  page.tracking-area.liquid  template da incollare nel tema
preview/
  anteprima.html           anteprima locale, solo per revisione
```

`lib/status.js` è l'unica fonte di verità del mapping. Cambiare un testo o uno
stato lì lo cambia ovunque, sincronizzazione e pagina.

---

## Cosa devi fare, in ordine

### 1. App nel Shopify Dev Dashboard

Crea l'app dal **Shopify Dev Dashboard** (non da Admin → Sviluppa app).

Scope Admin API da configurare sull'app:

```
read_orders, write_orders
read_fulfillments, write_fulfillments
read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders
```

Installa l'app sullo store e conserva **Client ID** e **Client secret**.

**Non serve nessun access token da copiare a mano.** L'app se lo ottiene da sola
via Client Credentials Grant, lo tiene in memoria e lo rinnova alla scadenza:

```
SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
     -> POST /admin/oauth/access_token (grant_type=client_credentials)
     -> access token temporaneo
     -> Admin GraphQL API
```

Il client secret serve anche a verificare l'HMAC dei webhook, perché i webhook
registrati dall'app via API sono firmati con quello. Una credenziale sola.

### 2. Test permessi — bloccante

È l'unica verifica che può fermare il progetto: stabilisce se Shopify accetta
eventi scritti da noi su fulfillment creati da Beestore.

```bash
cp .env.example .env      # compila SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
npm run test:permessi
```

Il progetto non ha dipendenze: non serve `npm install`, e riscompattare lo zip
sopra la cartella non rompe niente. `.env` non è nello zip, quindi sopravvive
agli aggiornamenti — ma controlla che ci sia ancora dopo aver riscompattato.

Il passo 0 del test verifica che il Client Credentials Grant funzioni: se
fallisce lì, il problema è nelle credenziali o nell'installazione dell'app.

Se la lettura funziona, ti stampa il comando per il test di scrittura. Prima di
lanciarlo fai il **passo 3**. L'evento scritto è `IN_TRANSIT` su un solo ordine.

> I fulfillment event non sono cancellabili via API. Scegli un ordine vecchio,
> già consegnato di fatto, di cui non ti importa la timeline.

Se il test fallisce, fermati e mandami l'errore: cambia l'architettura, non il codice.

### 3. Notifiche cliente — obbligatorio

Admin → Impostazioni → Notifiche → disattiva **"In consegna"** e **"Consegnato"**.

`fulfillmentEventCreate` non ha un parametro per sopprimere le notifiche: è
l'unico modo per garantire che l'app non generi comunicazioni. Senza questo
passo, il backfill manda centinaia di email su ordini consegnati settimane fa.

### 4. Deploy su Vercel

```bash
vercel link
vercel env add SHOPIFY_SHOP                # e tutte le altre di .env.example
vercel --prod
```

Genera i due segreti con `openssl rand -base64 32`:
`TRACKING_TOKEN_SECRET` e `SHIPPYPRO_WEBHOOK_SECRET`.

Fra le variabili c'è **`NODEJS_HELPERS=0`**: impedisce al runtime Vercel di
parsare il body prima di noi. Senza, l'HMAC dei webhook Shopify viene calcolato
su byte ricostruiti e non corrisponde mai. `/api/health` lo segnala.

Verifica la configurazione a deploy fatto:

```bash
curl "https://<progetto>.vercel.app/api/health?shopify=1"
```

Dice quali variabili mancano — mai il loro valore — e prova il grant Shopify.
Si può rimuovere `api/health.js` a messa in esercizio conclusa.

> `TRACKING_TOKEN_SECRET` non va più cambiato: da esso dipendono tutti i link di
> tracking già inviati ai clienti. Cambiarlo li invalida tutti.

Lascia **`DRY_RUN=1`** finché non hai completato il passo 6.

### 5. Webhook Shopify

Li registra l'app via API. Niente da inserire a mano in Admin:

```bash
npm run webhooks          # elenca lo stato attuale
npm run webhooks:apply
```

Crea `FULFILLMENTS_CREATE` e `FULFILLMENTS_UPDATE` verso
`$APP_BASE_URL/api/shopify/fulfillment`. È idempotente: rilanciarlo non duplica
nulla, e serve anche a spostarli se cambi dominio. `npm run webhooks:remove` li
toglie.

Servono solo a mantenere il link di tracking puntato alla nostra pagina.

> Registrandoli via API sono firmati con il **client secret dell'app**, la stessa
> credenziale dell'OAuth. I webhook creati a mano da Admin userebbero invece una
> chiave di firma diversa: non usare quella strada.

### 6. Webhook ShippyPro

ShippyPro → Integrations and API → API → **Add Webhook**:

- Evento: **Tracking Updates** (solo questo)
- URL: `https://<progetto>.vercel.app/api/shippypro/tracking`
- Custom header: `x-checkpoint-secret` = il valore di `SHIPPYPRO_WEBHOOK_SECRET`
- Retry: attivo

**Prima di collegarlo a noi**, puntalo per un'ora su un URL usa-e-getta
(webhook.site) e catturami **un payload reale**. Servono i nomi esatti dei campi
per codice spedizione, stato e timestamp: quelli in `extractEvents()` sono una
lista tollerante scritta senza documentazione, e va ridotta ai campi veri.

**L'account ShippyPro è condiviso fra più business.** La maggior parte degli
eventi riguarda spedizioni che non hanno nulla a che vedere con Shopify: senza
filtro ognuna costerebbe una ricerca sull'Admin API per poi essere scartata.

```bash
npm run marketplaces
```

Elenca i canali collegati e segnala quelli Shopify. Metti gli ID in
`SHIPPYPRO_MARKETPLACE_IDS`, nel `.env` e su Vercel.

> È solo un'ottimizzazione: la correttezza è già garantita dal fatto che il
> codice spedizione deve corrispondere a un fulfillment Shopify. Un ID
> dimenticato però significa eventi nostri scartati in silenzio — controlla
> l'elenco a occhio. Lista vuota = nessun filtro.

Fatto questo, imposta `DRY_RUN=0`.

### 7. Pagina nel tema

Tema → Modifica codice → `templates` → Aggiungi template tipo **page**, nome
**tracking-area**. Incolla `shopify/page.tracking-area.liquid` e sostituisci
`CP_API_BASE` con il dominio Vercel.

Admin → Pagine → *tracking-area* → Template = `page.tracking-area`.

In `theme.liquid`, dentro `<head>`, una riga per tenerla fuori da Google:

```liquid
{% if page.template_suffix == 'tracking-area' %}<meta name="robots" content="noindex">{% endif %}
```

Verifica aprendo l'URL nudo: senza `?o=` e `?t=` deve mostrare "Link non valido".

### 8. Sincronizzazione iniziale — una tantum

**Va fatta PRIMA di riscrivere i link.** Finché gli ordini non hanno stati,
la pagina mostra "Ordine in lavorazione" per tutti: un cliente con il pacco
già in consegna leggerebbe che non è ancora partito. Peggio della situazione
attuale. Prima gli stati, poi i link.

```bash
npm run backfill                    # dry-run, produce un CSV
npm run backfill:apply -- --days 45
```

Controlla il CSV prima di applicare. Circa 550 ordini spediti negli ultimi 30
giorni: con il rate limit ShippyPro di 20 chiamate ogni 10 secondi sono circa
7 minuti.

### 9. Riscrittura dei link — una tantum

```bash
npm run urls            # dry-run: elenca cosa cambierebbe
npm run urls:apply
```

Verifica un link a campione con `npm run link <ordine> -- --check` prima di
applicare a tutti. Da qui in avanti ci pensa il webhook del passo 5.

### 10. Chiusura

Disinstalla **Track123** subito dopo il passo 9: due app che riscrivono
`trackingInfo.url` si sovrascrivono a vicenda, e finché convivono il link può
tornare a puntare al vettore senza preavviso.

Riattiva le notifiche del passo 3 solo ora, se le vuoi attive.

---

## Verifiche finali

- [ ] Un ordine in lavorazione mostra "Ordine in lavorazione" e nessun link al corriere
- [ ] Un ordine in transito mostra "Traccia la spedizione" e il link porta al vettore
- [ ] Un ordine consegnato non mostra più il pulsante
- [ ] Un ordine con due spedizioni mostra due card separate
- [ ] Il tag `consegnato` compare solo a ordine completo e tutte le spedizioni consegnate
- [ ] Nessuna email è partita durante i test
- [ ] Un webhook ShippyPro ripetuto due volte non crea un secondo evento

---

## Tag ordine

### Scritti da altri — l'app li legge e basta

| Tag | Usato dall'app |
|---|---|
| `spedizione_prevista=AAAA-MM-GG` | **Sì**, unico tag letto |
| `codice_soc=…` | No |
| `soc_atleta=…` | No |
| `soc_categoria=…` | No |
| `soc_nome=…` | No |
| `alert` | **Sì**, nasconde la data prevista |

`soc_atleta`, `soc_nome` e `codice_soc` contengono dati di persone e società.
La pagina tracking è raggiungibile con un link condivisibile, quindi **nessun tag
esce mai dall'API**: viene esposta solo la data prevista, già trasformata in
etichetta ("25 agosto"), mai la data ISO e mai il tag.

`npm run test:tag` lo verifica esplicitamente. Rilanciarlo dopo ogni modifica a
`toPublicShape()`.

**Il flag `alert`** segnala un dato mancante a monte: la data calcolata non è
affidabile, e promettere una spedizione che slitterà genera proprio le richieste
al customer service che questa pagina deve evitare. Con `alert` presente la data
non viene mostrata; il resto della pagina funziona normalmente.
Si disattiva con `HIDE_ETA_ON_ALERT = false` in `lib/orders.js`.

**Regole sulla data prevista**: solo formato ISO, un tag non conforme viene
ignorato in silenzio, con più tag validi vince la data più lontana, il confronto
avviene sulla data civile in `Europe/Rome`, il testo è sempre "Spedizione
prevista" e mai "Consegna prevista". La data sparisce al primo evento vettore
anche se il tag resta sull'ordine.

### Scritti dall'app

| Tag | Quando |
|---|---|
| `consegnato` | Ordine completamente evaso e tutte le spedizioni consegnate |
| `spedizione_problema` | Pacco danneggiato, smarrito o distrutto (ShippyPro 5320/5330/5340) |
| `reso_in_rientro` | Spedizione in rientro al mittente (ShippyPro 5630) |

Stile allineato al vostro: minuscolo, underscore, flag nudo quando non c'è un
valore, come `alert`. Definiti in `lib/tags.js`, un punto solo.

Gli ultimi due esistono perché `Returning to Sender` e i danni pacco non hanno
un equivalente negli 11 stati Shopify: il tag li rende filtrabili in Admin e
utilizzabili come trigger Shopify Flow, cosa che i fulfillment event non
permettono. L'app non tocca mai i tag scritti da altri.

---

## Da definire

**Metodo API ShippyPro per il backfill.** `SHIPPYPRO_TRACK_METHOD` è impostato a
`GetTracking` per ipotesi: la documentazione ufficiale non è consultabile senza
account. Va confermato prima del passo 9. Il funzionamento a regime non ne dipende.

---

## Anteprima locale

```bash
node scripts/build-preview.mjs
open preview/anteprima.html
```

L'anteprima estrae CSS e JS dal template reale e li esegue con dati finti: se la
pagina cambia, l'anteprima cambia con lei. Non usa dati veri e non va pubblicata.

---

## Note di progetto

**Perché serve un endpoint.** Shopify non può ricevere webhook di terze parti né
custodire un token Admin lato client. Shopify Functions, Flow e le Theme App
Extension sono stati valutati e nessuno copre il caso. È l'unico componente
esterno del progetto: una funzione stateless.

**Perché nessun database.** Il collegamento `codice spedizione → ordine` si
risolve con la ricerca full-text di Shopify in una sola query, e l'ultimo stato è
già registrato come fulfillment event. Non c'è nulla da persistere.

> Il filtro `tracking_number:` **non esiste** nella search syntax di Shopify:
> viene ignorato in silenzio e la query restituisce tutti gli ordini dello store.
> Va usata la ricerca full-text nuda. È scritto anche in `lib/orders.js`.

**Limite 60 giorni.** Senza lo scope `read_all_orders`, la Admin API espone solo
gli ordini degli ultimi 60 giorni. Un codice spedizione più vecchio risulta
"non trovato" e il backfill oltre i 60 giorni restituisce meno ordini **senza
dare errore**. Per questo la finestra predefinita è 45 giorni e gli script
avvisano oltre i 55. `read_all_orders` va richiesto a Shopify e concesso caso
per caso: per questa app non serve, le spedizioni oltre i 60 giorni sono chiuse.

**Stesso codice su più fulfillment.** Capita che una spedizione compaia su più
fulfillment dello stesso ordine. `findOrderByTracking` restituisce tutti i
fulfillment corrispondenti e il webhook li aggiorna tutti: fermarsi al primo
lascerebbe gli altri senza stati per sempre.

**Perché la mappa corrieri.** Sovrascrivendo `trackingInfo.url` con la nostra
pagina, l'URL originale del vettore non è più leggibile da Shopify e va
ricostruito da nome corriere + codice. Se il corriere non è in `lib/carriers.js`
il pulsante non compare e resta solo il codice: meglio nessun link che uno rotto.

**Se in futuro ShippyPro parlerà direttamente con Shopify.** Il modulo A non
dipende da chi crea il fulfillment, solo dal codice spedizione. Continua a
funzionare identico. Per spegnerlo basta rimuovere il webhook su ShippyPro.
