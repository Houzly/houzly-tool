/**
 * Template contratto di mandato Houzly — versione 1.5
 *
 * REGOLA: questo file non si modifica mai dopo che una pratica lo ha usato.
 * Per cambiare il testo si crea mandato-v1.6.js e si aggiorna templates/index.js.
 * Ogni pratica firmata conserva comunque il proprio snapshot in DB.
 *
 * Placeholder disponibili nei testi: {{chiave.sottochiave}}
 *   mandante.*   → nomeCognome, luogoNascita, dataNascita, residenza, cfPiva
 *   immobile.*   → indirizzo, piano, interno, foglio, particella, subalterno,
 *                  categoria, cin
 *   commissione            → es. "30% (trenta per cento)"
 *   sogliaSpesa            → es. "€ 50,00 (cinquanta/00)"
 *   preavvisoRecesso       → es. "6 (sei) mesi"
 *   foro                   → es. "Arezzo"
 *
 * Ogni comma può avere: { n, testo, elenco: [], bold: true }
 * Ogni articolo può avere: { id, numero, titolo, commi: [], opzionale: true }
 * Gli articoli con opzionale:true vengono inclusi solo se attivati nella pratica.
 */

module.exports = {
  versione: '1.5',
  dataVersione: 'Settembre 2026',

  intestazione: {
    headerSx: 'HOUZLY · Luxury Property Management',
    headerDx: 'Contratto-tipo di mandato',
    footer:
      'Houzly Snc · P.IVA 02499920516 · Terranuova Bracciolini (AR) · www.houzly.it',
    occhiello: 'AZIENDA di PROPERTY MANAGEMENT',
    titolo: 'CONTRATTO DI MANDATO CON RAPPRESENTANZA E MANDATO ALL\u2019INCASSO',
    sottotitolo:
      'per la gestione in locazione breve di immobile ad uso abitativo',
  },

  preambolo:
    'Redatto ai sensi degli artt. 1703 e ss. c.c. (mandato), 1387 e ss. c.c. (rappresentanza) e ' +
    'dell\u2019art. 4 del DL 50/2017 conv. in L. 96/2017, nonch\u00e9 in conformit\u00e0 alla Legge Regionale ' +
    'Toscana n. 61/2024 in materia di ricettivit\u00e0, turismo e attrattivit\u00e0 del territorio, e ' +
    'successive modifiche e integrazioni.',

  mandataria:
    'La societ\u00e0 **HOUZLY SNC DI CARELLA DANIELE E RUBERTI ROMEO**, con sede legale in ' +
    '**Via Alcide De Gasperi 90, Terranuova Bracciolini (AR)**, P. IVA **02499920516**, esercente ' +
    'in forma imprenditoriale l\u2019attivit\u00e0 di gestione e conduzione di strutture ricettive di natura ' +
    'turistica, in persona del legale rappresentante pro tempore Daniele Carella, di seguito ' +
    '\u201cMandataria\u201d o \u201cHouzly\u201d;',

  mandante:
    'Il/La Sig./Sig.ra / Ragione Sociale **{{mandante.nomeCognome}}**, nato/a a ' +
    '**{{mandante.luogoNascita}}** il **{{mandante.dataNascita}}**, residente / con sede in ' +
    '**{{mandante.residenza}}**, C.F. / P.IVA **{{mandante.cfPiva}}**, di seguito \u201cMandante\u201d ' +
    'o \u201cProprietario\u201d.',

  premesse: [
    {
      lettera: 'a',
      testo:
        'il Mandante \u00e8 proprietario esclusivo dell\u2019immobile sito in **{{immobile.indirizzo}}**, ' +
        'piano {{immobile.piano}}, interno {{immobile.interno}}, identificato catastalmente al ' +
        'Foglio {{immobile.foglio}} Particella {{immobile.particella}} Subalterno ' +
        '{{immobile.subalterno}}, categoria catastale {{immobile.categoria}}, di seguito ' +
        'l\u2019\u201cImmobile\u201d, come meglio rappresentato nella planimetria allegata;',
    },
    {
      lettera: 'b',
      testo:
        'l\u2019Immobile \u00e8 dotato (o sar\u00e0 dotato a cura della Mandataria) di Codice Identificativo ' +
        'Nazionale (CIN) n. {{immobile.cin}}, ai sensi del DL 145/2023 e della normativa regionale ' +
        'applicabile;',
    },
    {
      lettera: 'c',
      testo:
        'il Mandante intende destinare l\u2019Immobile alla locazione breve per finalit\u00e0 turistiche, ' +
        'ai sensi dell\u2019art. 4 del DL 50/2017 conv. in L. 96/2017 e successive modificazioni, e della ' +
        'L.R. Toscana n. 61/2024;',
    },
    {
      lettera: 'd',
      testo:
        'la Mandataria \u00e8 societ\u00e0 specializzata nella gestione professionale di immobili destinati ' +
        'alla locazione breve, opera con software gestionali professionali (a titolo esemplificativo ' +
        'Smoobu, PriceLabs) ed \u00e8 accreditata sui principali canali di distribuzione (Airbnb, Booking, ' +
        'VRBO, Expedia);',
    },
    {
      lettera: 'e',
      testo:
        'la Mandataria opera in regime di mandato con rappresentanza e di mandato all\u2019incasso e ' +
        'agisce quale intermediario che incassa i corrispettivi ex art. 4 DL 50/2017, assumendo la ' +
        'qualifica di sostituto d\u2019imposta per conto dei propri Mandanti;',
    },
    {
      lettera: 'f',
      testo:
        'il Mandante \u00e8 interessato ad affidare alla Mandataria, in via esclusiva, l\u2019incarico di ' +
        'promuovere, gestire e amministrare l\u2019Immobile per finalit\u00e0 ricettive di breve periodo.',
    },
  ],

  articoli: [
    {
      id: 'art1',
      numero: 'Art. 1',
      titolo: 'Premesse e allegati',
      commi: [
        {
          n: '1.1',
          testo:
            'Le premesse e gli allegati (ove presenti) formano parte integrante e sostanziale del ' +
            'presente contratto.',
        },
        {
          n: '1.2',
          testo:
            'Sono allegati al contratto, ove applicabili: (A) scheda Immobile con dotazioni, arredo ' +
            'e documentazione fotografica dello stato di consegna; (B) informativa e nomina a ' +
            'Responsabile esterno del trattamento ex art. 28 GDPR; (C) planimetria e visura catastale.',
        },
      ],
    },
    {
      id: 'art2',
      numero: 'Art. 2',
      titolo: 'Oggetto del mandato con rappresentanza e mandato all\u2019incasso',
      commi: [
        {
          n: '2.1',
          testo:
            'Il Mandante conferisce alla Mandataria, che accetta, mandato con rappresentanza ai ' +
            'sensi degli artt. 1703 e ss. e 1387 e ss. c.c., unitamente a mandato all\u2019incasso, ' +
            'affinch\u00e9 in nome e per conto del Mandante provveda alla gestione integrale ' +
            'dell\u2019Immobile in regime di locazione breve.',
        },
        {
          n: '2.2',
          testo: 'Il mandato comprende, a titolo esemplificativo e non esaustivo:',
          elenco: [
            'la promozione dell\u2019Immobile sui canali di distribuzione online (OTA) e diretti, con ' +
              'ogni mezzo idoneo, inclusi i siti web e il channel manager;',
            'la predisposizione della scheda informativa dell\u2019immobile e del vademecum per gli ' +
              'ospiti (uso apparecchiature, servizi di zona, trasporti, ecc.);',
            'la realizzazione del materiale fotografico e multimediale per la promozione;',
            'la stipula dei contratti di locazione breve con gli ospiti in nome e per conto del Mandante;',
            'la riscossione dei canoni, delle cauzioni (ove richiesto) e dei corrispettivi per servizi ' +
              'accessori (mandato all\u2019incasso);',
            'l\u2019accoglienza degli ospiti (check-in/check-out), la gestione delle pulizie di soggiorno ' +
              'e della biancheria;',
            'la manutenzione ordinaria e le piccole riparazioni dovute all\u2019uso, entro la soglia di ' +
              'spesa autonoma di cui all\u2019art. 11;',
            'gli adempimenti fiscali e di sostituto d\u2019imposta di cui all\u2019art. 8;',
            'la richiesta del CIN e gli adempimenti amministrativi connessi all\u2019attivit\u00e0 ricettiva;',
            'gli adempimenti di pubblica sicurezza: comunicazione dei dati degli ospiti al Portale ' +
              'Alloggiati Web della Questura ex art. 109 TULPS;',
            'la riscossione e il versamento della tassa di soggiorno al Comune competente;',
            'le comunicazioni alle banche dati regionali e agli Uffici ISTAT secondo la Regione di ' +
              'ubicazione dell\u2019Immobile.',
          ],
        },
      ],
    },
    {
      id: 'art3',
      numero: 'Art. 3',
      titolo: 'Esclusiva',
      commi: [
        {
          n: '3.1',
          testo:
            'L\u2019incarico \u00e8 conferito in via esclusiva. Per tutta la durata del contratto, il ' +
            'Mandante si impegna a non affidare la gestione dell\u2019Immobile, in tutto o in parte, ad ' +
            'altri intermediari o operatori terzi, n\u00e9 a concludere autonomamente o tramite terzi ' +
            'contratti di locazione breve relativi all\u2019Immobile.',
        },
        {
          n: '3.2',
          testo:
            'La violazione del presente articolo costituisce inadempimento grave e legittima il ' +
            'recesso immediato della Mandataria ai sensi dell\u2019art. 1456 c.c., fatto salvo il ' +
            'risarcimento del danno.',
        },
      ],
    },
    {
      id: 'art4',
      numero: 'Art. 4',
      titolo: 'Durata e recesso',
      commi: [
        {
          n: '4.1',
          testo:
            'Il presente contratto ha durata di 1 (uno) anno a decorrere dalla data di ' +
            'sottoscrizione e si rinnova tacitamente per uguale periodo, salvo disdetta.',
        },
        {
          n: '4.2',
          testo:
            'Ciascuna parte pu\u00f2 recedere mediante comunicazione scritta a mezzo PEC o raccomandata ' +
            'A/R, con preavviso di almeno {{preavvisoRecesso}} rispetto alla data di efficacia del ' +
            'recesso, salva la giusta causa di cui al comma 4.4.',
        },
        {
          n: '4.3',
          testo:
            'Il recesso non comporta penale o indennit\u00e0. Le prenotazioni gi\u00e0 confermate alla data ' +
            'di efficacia del recesso saranno comunque onorate e gestite dalla Mandataria sino alla ' +
            'conclusione del soggiorno, alle condizioni economiche di cui all\u2019art. 7; in difetto, la ' +
            'parte recedente si far\u00e0 integralmente carico dei costi e dei danni derivanti dalla loro ' +
            'cancellazione o mancato adempimento.',
        },
        {
          n: '4.4',
          testo:
            '\u00c8 salvo il diritto di ciascuna parte di recedere per giusta causa, senza preavviso, in ' +
            'caso di inadempimento grave dell\u2019altra parte.',
        },
      ],
    },
    {
      id: 'art5',
      numero: 'Art. 5',
      titolo: 'Consegna dell\u2019Immobile e documentazione',
      commi: [
        {
          n: '5.1',
          testo:
            'Il Mandante consegna alla Mandataria la documentazione obbligatoria per lo svolgimento ' +
            'dell\u2019attivit\u00e0: dichiarazione di conformit\u00e0 degli impianti, visura e planimetria ' +
            'catastale, e ogni altro documento necessario o obbligatorio.',
        },
        {
          n: '5.2',
          testo:
            'Qualora taluni documenti non siano disponibili, il Mandante esonera la Mandataria da ' +
            'ogni responsabilit\u00e0 conseguente; la Mandataria accetta una congrua dilazione, ' +
            'riservandosi il diritto di recedere unilateralmente dal contratto senza nulla a pretendere.',
        },
        {
          n: '5.3',
          testo:
            'Il Mandante garantisce la regolarit\u00e0 urbanistica, catastale ed edilizia dell\u2019Immobile ' +
            'e la veridicit\u00e0 delle dichiarazioni rese, manlevando la Mandataria da pretese di terzi ' +
            'connesse a vizi o irregolarit\u00e0 non imputabili alla Mandataria.',
        },
      ],
    },
    {
      id: 'art6',
      numero: 'Art. 6',
      titolo: 'Pulizia iniziale per apertura attivit\u00e0',
      commi: [
        {
          n: '6.1',
          testo:
            'Il Mandante prende atto e accetta che, prima dell\u2019avvio dell\u2019attivit\u00e0 ricettiva e ' +
            'della pubblicazione operativa dell\u2019Immobile sui canali di vendita, dovr\u00e0 essere ' +
            'eseguita una pulizia straordinaria iniziale e approfondita, necessaria a garantire ' +
            'adeguati standard igienici, qualitativi e di presentazione.',
        },
        {
          n: '6.2',
          testo:
            'Tale pulizia iniziale \u00e8 organizzata, coordinata e gestita dalla Mandataria, ' +
            'direttamente o tramite l\u2019azienda di pulizia e/o i fornitori da essa incaricati, secondo ' +
            'gli standard richiesti per l\u2019avvio dell\u2019attivit\u00e0.',
        },
        {
          n: '6.3',
          testo:
            'Il relativo costo resta interamente a carico del Mandante e potr\u00e0 essere addebitato ' +
            'separatamente ovvero trattenuto dai primi incassi generati dalla struttura, previa ' +
            'comunicazione dell\u2019importo al Mandante.',
        },
        {
          n: '6.4',
          testo:
            'La pulizia iniziale per apertura attivit\u00e0 costituisce intervento straordinario e non ' +
            'rientra nelle ordinarie pulizie di soggiorno/check-out, disciplinate dall\u2019art. 7.',
        },
      ],
    },
    {
      id: 'art7',
      numero: 'Art. 7',
      titolo: 'Compenso della Mandataria, pulizie di soggiorno e mandato all\u2019incasso',
      commi: [
        {
          n: '7.1',
          testo:
            'A fronte dei servizi di cui al presente contratto, il Mandante riconosce alla ' +
            'Mandataria una commissione di gestione pari al **{{commissione}}**, IVA inclusa, ' +
            'dell\u2019importo netto percepito dagli ospiti, dopo la detrazione delle eventuali ' +
            'commissioni delle piattaforme di intermediazione (OTA).',
        },
        {
          n: '7.2',
          testo:
            'In forza del mandato all\u2019incasso, la Mandataria incassa direttamente dagli ospiti i ' +
            'canoni e i corrispettivi e trattiene la propria commissione, fatturata al cliente finale ' +
            'o al Mandante secondo il modello fiscale adottato, riconoscendo al Mandante la quota ' +
            'spettante secondo l\u2019art. 9.',
        },
        {
          n: '7.3',
          testo:
            'Le pulizie di fine soggiorno (check-out) e la fornitura/sostituzione della biancheria a ' +
            'ogni check-out sono organizzate e gestite dalla Mandataria e addebitate direttamente agli ' +
            'ospiti; pertanto, non gravano sul Mandante, salvo quanto previsto agli artt. 6 e 10.4 per ' +
            'la pulizia iniziale e per l\u2019uso personale dell\u2019Immobile.',
        },
      ],
    },
    {
      id: 'art8',
      numero: 'Art. 8',
      titolo: 'Gestione fiscale e adempimenti del sostituto d\u2019imposta',
      commi: [
        {
          n: '8.1',
          testo:
            'La Mandataria, agendo quale intermediario che incassa i corrispettivi ai sensi ' +
            'dell\u2019art. 4 del DL 50/2017, opera in qualit\u00e0 di sostituto d\u2019imposta nei confronti ' +
            'del Mandante.',
        },
        {
          n: '8.2',
          testo:
            'Il Mandante prende atto che la Mandataria, in qualit\u00e0 di sostituto d\u2019imposta ai sensi ' +
            'dell\u2019art. 4 del DL 50/2017, \u00e8 obbligata per legge a operare una ritenuta del 21% a ' +
            'titolo d\u2019acconto sul canone di locazione puro, come definito al comma 8.3. Tale ritenuta ' +
            'non costituisce di per s\u00e9 applicazione della cedolare secca: la scelta del regime fiscale ' +
            '(cedolare secca ovvero regime ordinario IRPEF) \u00e8 effettuata dal Mandante, con ' +
            'l\u2019assistenza del proprio commercialista, in sede di dichiarazione dei redditi, nella ' +
            'quale la ritenuta subita sar\u00e0 scomputata dall\u2019imposta dovuta secondo il regime ' +
            'prescelto. Il Mandante conferisce pertanto alla Mandataria mandato affinch\u00e9:',
          elenco: [
            'operi la ritenuta del 21% a titolo d\u2019acconto sul canone di locazione puro, come ' +
              'definito al comma 8.3;',
            'versi mensilmente la ritenuta mediante modello F24, codice tributo 1919, entro il giorno ' +
              '16 del mese successivo a quello dell\u2019incasso;',
            'trasmetta telematicamente all\u2019Agenzia delle Entrate la Certificazione Unica (CU) entro ' +
              'il 16 marzo dell\u2019anno successivo a quello di riferimento, inviando contestualmente al ' +
              'Mandante copia della CU in formato PDF riepilogativo, utile ai fini della dichiarazione ' +
              'dei redditi;',
            'trasmetta il modello 770 entro il 31 ottobre dell\u2019anno successivo;',
            'effettui la Comunicazione DAC7 ex D.Lgs. 32/2023 entro il 31 gennaio dell\u2019anno ' +
              'successivo, ricomprendendo il Mandante tra i soggetti oggetto di comunicazione.',
          ],
        },
        {
          n: '8.3',
          testo:
            'Si definisce **\u201ccanone di locazione puro\u201d** \u2014 base imponibile della ritenuta del ' +
            '21% \u2014 il canone lordo incassato dall\u2019ospite **al netto delle commissioni delle ' +
            'piattaforme di intermediazione (OTA) e della commissione della Mandataria**. La ritenuta ' +
            'del 21% \u00e8 calcolata su tale importo netto.',
        },
        {
          n: '8.4',
          testo:
            'Tale criterio di determinazione della base imponibile \u00e8 adottato in conformit\u00e0 ' +
            'all\u2019interpretazione formalizzata da AIGAB (Associazione Italiana Gestori Affitti Brevi) ' +
            'nelle proprie FAQ ufficiali, elaborate con il dott. Sergio Lombardi, Presidente ' +
            'dell\u2019Osservatorio sul Turismo dell\u2019Ordine dei Dottori Commercialisti di Roma, secondo ' +
            'cui la ritenuta \u2014 e l\u2019eventuale cedolare secca, ove optata dal Mandante \u2014 si applica ' +
            'sul canone netto risultante in Certificazione Unica.',
        },
        {
          n: '8.5',
          testo:
            'La Mandataria provvede inoltre alla riscossione e al versamento della tassa di soggiorno ' +
            'al Comune competente, secondo modalit\u00e0 e scadenze del regolamento comunale applicabile.',
        },
      ],
    },
    {
      id: 'art9',
      numero: 'Art. 9',
      titolo: 'Rendicontazione e accredito al Mandante',
      commi: [
        {
          n: '9.1',
          testo:
            'Entro il giorno 10 di ogni mese, la Mandataria trasmette al Mandante un report mensile ' +
            'dettagliato relativo al mese precedente, contenente: elenco delle prenotazioni con date, ' +
            'ospiti, canali e importi; totale canoni lordi incassati; totale commissioni OTA; Spese di ' +
            'Pulizia; commissione Houzly; canone di locazione puro (base imponibile della ritenuta); ' +
            'ritenuta del 21% a titolo d\u2019acconto versata; netto spettante al Mandante.',
        },
        {
          n: '9.2',
          testo:
            'Il bonifico dell\u2019importo netto spettante al Mandante \u00e8 effettuato entro il giorno 10 ' +
            'del mese successivo a quello di riferimento del report, allegando la ricevuta di ' +
            'versamento della ritenuta.',
        },
        {
          n: '9.3',
          testo:
            'Il Mandante pu\u00f2 consultare in tempo reale il calendario delle prenotazioni tramite ' +
            'l\u2019accesso al sistema gestionale fornito dalla Mandataria.',
        },
      ],
    },
    {
      id: 'art10',
      numero: 'Art. 10',
      titolo: 'Utilizzo dell\u2019Immobile da parte del Mandante',
      commi: [
        {
          n: '10.1',
          testo:
            'Il Mandante ha facolt\u00e0 di utilizzare personalmente l\u2019Immobile, per uso non ' +
            'commerciale, previa richiesta alla Mandataria e solo in assenza di soggiorni programmati, ' +
            'prenotazioni confermate o richieste in via di definizione.',
        },
        {
          n: '10.2',
          testo:
            'Il Mandante pu\u00f2 consultare il calendario delle disponibilit\u00e0 tramite il sistema ' +
            'gestionale; resta inteso che solo la Mandataria pu\u00f2 confermare la disponibilit\u00e0 e ' +
            'autorizzare il soggiorno.',
        },
        {
          n: '10.3',
          testo:
            'La Mandataria si riserva la facolt\u00e0 di non accogliere le richieste di utilizzo ' +
            'personale nel periodo di altissima stagione **{{altaStagione}}**, nonch\u00e9 in periodi di ' +
            'elevata redditivit\u00e0, al fine di non pregiudicare i risultati economici della gestione.',
        },
        {
          n: '10.4',
          testo:
            'Al termine di ogni utilizzo da parte del Mandante o di suoi ospiti, l\u2019Immobile \u00e8 ' +
            'sottoposto al servizio di pulizia professionale necessario a ripristinare gli standard ' +
            'ricettivi, eseguito dai fornitori designati dalla Mandataria; il relativo costo della ' +
            'pulizia finale resta a carico del Mandante secondo il tariffario vigente.',
        },
        {
          n: '10.5',
          testo:
            'Non \u00e8 ammesso l\u2019annullamento di prenotazioni gi\u00e0 confermate; qualora il Mandante ' +
            'intenda comunque procedere, sosterr\u00e0 integralmente le relative penali, inclusi gli ' +
            'eventuali mancati guadagni.',
        },
      ],
    },
    {
      id: 'art11',
      numero: 'Art. 11',
      titolo: 'Manutenzione, danni e soglia di spesa autonoma',
      commi: [
        {
          n: '11.1',
          testo:
            'La Mandataria \u00e8 autorizzata a effettuare, senza preventiva autorizzazione del ' +
            'Mandante, interventi di manutenzione ordinaria e piccole riparazioni dovute all\u2019uso fino ' +
            'all\u2019importo di **{{sogliaSpesa}}** per singolo intervento.',
        },
        {
          n: '11.2',
          testo:
            'Per interventi di importo superiore, e per ogni manutenzione straordinaria o riparazione ' +
            'dovuta a vetust\u00e0 o caso fortuito, \u00e8 necessaria la preventiva autorizzazione scritta ' +
            'del Mandante, con indicazione di preventivo e tempistiche; tali interventi sono di ' +
            'competenza economica del Mandante.',
        },
        {
          n: '11.3',
          testo:
            'In caso di urgenza per la salvaguardia dell\u2019Immobile o per garantirne la fruibilit\u00e0 ' +
            'da parte degli ospiti, la Mandataria pu\u00f2 procedere anche oltre la soglia, dandone ' +
            'tempestiva comunicazione al Mandante.',
        },
        {
          n: '11.4',
          testo:
            'Per ogni modifica, acquisto o riparazione dell\u2019arredo che renda necessario ' +
            'l\u2019intervento del Mandante, quest\u2019ultimo dovr\u00e0 provvedere entro 24 ore dalla ' +
            'richiesta; in difetto, la Mandataria potr\u00e0 procedere direttamente ai sensi dei commi ' +
            'precedenti, con diritto al rimborso.',
        },
        {
          n: '11.5',
          testo:
            'Le spese di manutenzione e i costi di intervento sono a carico del Mandante e possono ' +
            'essere trattenuti sull\u2019accredito mensile successivo, previa fatturazione. I danni ' +
            'causati dagli ospiti, se non recuperabili tramite la cauzione o la copertura assicurativa, ' +
            'sono a carico del Mandante.',
        },
      ],
    },
    {
      id: 'art11bis',
      numero: 'Art. 11-bis',
      titolo:
        'Servizi accessori di gestione del verde e della piscina (opzionali, su richiesta del Mandante)',
      commi: [
        {
          n: '11-bis.1',
          testo:
            'La gestione ordinaria delle aree verdi pertinenziali (giardino, prato, siepi, alberature, ' +
            'irrigazione) e/o della piscina (trattamento chimico delle acque, pulizia, manutenzione ' +
            'tecnica degli impianti, apertura e chiusura stagionale) non rientra nei servizi ordinari ' +
            'del presente mandato e non \u00e8 automaticamente compresa nella commissione di cui ' +
            'all\u2019art. 7.',
        },
        {
          n: '11-bis.2',
          testo:
            'Tali servizi sono erogati esclusivamente su richiesta espressa del Mandante e previa ' +
            'attivazione disciplinata dai commi seguenti. In assenza di attivazione, ogni onere ' +
            'relativo alla cura del verde e della piscina resta in capo al Mandante, che vi ' +
            'provveder\u00e0 direttamente e a propria cura, garantendo comunque le condizioni di ' +
            'fruibilit\u00e0 e sicurezza dell\u2019Immobile per gli ospiti.',
        },
        {
          n: '11-bis.3',
          testo:
            'La Mandataria, qualora richiesto, delega l\u2019esecuzione materiale dei servizi a ' +
            'professionisti terzi qualificati (a titolo esemplificativo: aziende agricole e di ' +
            'giardinaggio, ditte specializzate nel trattamento di piscine), da essa selezionati e ' +
            'coordinati. La Mandataria resta unico interlocutore operativo del Mandante per tali ' +
            'servizi, in coerenza con la logica del mandato.',
        },
        {
          n: '11-bis.4',
          testo:
            'A seguito della richiesta di attivazione, la Mandataria organizza un sopralluogo tecnico ' +
            'con i fornitori incaricati, all\u2019esito del quale verranno determinati: (i) la consistenza ' +
            'e la frequenza degli interventi necessari, in relazione alle caratteristiche specifiche ' +
            'dell\u2019Immobile e delle sue pertinenze; (ii) il corrispettivo economico dovuto ai ' +
            'fornitori per la prestazione; (iii) la commissione di coordinamento e gestione spettante ' +
            'alla Mandataria, pari al **{{commissioneMaggiorata}}**, in misura percentuale maggiorata ' +
            'rispetto a quella di cui all\u2019art. 7, in ragione del maggior onere organizzativo, di ' +
            'supervisione e di responsabilit\u00e0 connesso al servizio.',
        },
        {
          n: '11-bis.5',
          testo:
            'La Mandataria seleziona i fornitori secondo criteri di professionalit\u00e0, ma non risponde ' +
            'dei vizi della prestazione resa dai terzi, restando obbligata unicamente al diligente ' +
            'coordinamento ai sensi dell\u2019art. 1176, comma 2, c.c. Eventuali contestazioni sulla ' +
            'qualit\u00e0 del servizio reso saranno gestite dalla Mandataria nei confronti del fornitore ' +
            'per conto del Mandante.',
        },
      ],
    },
    {
      id: 'art12',
      numero: 'Art. 12',
      titolo: 'Utenze e spese condominiali',
      commi: [
        {
          n: '12.1',
          testo:
            'Le utenze (energia elettrica, gas, acqua, riscaldamento, condizionamento, internet, ' +
            'canone RAI) sono intestate al Mandante e a suo carico; il Mandante si impegna a ' +
            'mantenerle attive per tutta la durata del contratto.',
        },
        {
          n: '12.2',
          testo: 'Le spese condominiali, ordinarie e straordinarie, sono a carico del Mandante.',
        },
      ],
    },
    {
      id: 'art13',
      numero: 'Art. 13',
      titolo: 'Copertura assicurativa',
      commi: [
        {
          n: '13.1',
          testo:
            'La Mandataria dichiara di non disporre di una polizza assicurativa aziendale propria a ' +
            'copertura dei rischi connessi alla locazione breve dell\u2019Immobile.',
        },
        {
          n: '13.2',
          testo:
            'Le coperture eventualmente disponibili sono quelle offerte dalle piattaforme di ' +
            'intermediazione, con i limiti e le esclusioni dei rispettivi regolamenti, e segnatamente:',
          elenco: [
            'Airbnb \u2014 \u201cAirCover per gli host\u201d: copertura per danni alla propriet\u00e0 e ' +
              'responsabilit\u00e0 civile verso terzi, nei limiti e secondo le condizioni stabilite da Airbnb;',
            'Booking.com \u2014 \u201cPartner Liability Insurance\u201d: copertura della sola ' +
              'responsabilit\u00e0 civile verso terzi; i danni alla propriet\u00e0 sono gestiti tramite il ' +
              '\u201cProgramma Protezione Danni\u201d che prevede una richiesta di rimborso da parte ' +
              'dell\u2019ospite fino ad un tetto massimo di \u20ac300.',
          ],
        },
        {
          n: '13.3',
          testo:
            'Tali coperture di piattaforma non sono sostitutive di una polizza dedicata. Alla luce di ' +
            'questo, la Mandataria raccomanda al Mandante di stipulare e mantenere una polizza ' +
            'assicurativa personale dedicata alla locazione breve, a copertura della responsabilit\u00e0 ' +
            'civile verso terzi e dei danni all\u2019Immobile.',
        },
      ],
    },
    {
      id: 'art14',
      numero: 'Art. 14',
      titolo: 'Materiale fotografico e propriet\u00e0 intellettuale',
      commi: [
        {
          n: '14.1',
          testo:
            'Il materiale fotografico, i video e ogni altro contenuto multimediale realizzato dalla ' +
            'Mandataria, o da professionisti da essa incaricati, all\u2019interno dell\u2019Immobile durante ' +
            'la vigenza del presente contratto, costituiscono propriet\u00e0 intellettuale esclusiva della ' +
            'Mandataria (Houzly).',
        },
        {
          n: '14.2',
          testo:
            'Il Mandante ha diritto all\u2019uso non commerciale di tale materiale durante la vigenza del ' +
            'contratto, per finalit\u00e0 personali. Al termine del contratto, la Mandataria potr\u00e0 ' +
            'conservare e utilizzare il materiale per il proprio archivio commerciale, ma cesser\u00e0 di ' +
            'pubblicizzare l\u2019Immobile. Salvo diverso accordo scritto, il materiale non \u00e8 trasferito ' +
            'o ceduto al Mandante.',
        },
        {
          n: '14.3',
          testo:
            'L\u2019eventuale materiale fotografico preesistente e di propriet\u00e0 del Mandante prima ' +
            'dell\u2019inizio del contratto resta integralmente di propriet\u00e0 del Mandante.',
        },
      ],
    },
    {
      id: 'art15',
      numero: 'Art. 15',
      titolo: 'Privacy e protezione dei dati personali',
      commi: [
        {
          n: '15.1',
          testo:
            'Le parti si impegnano al rispetto del Reg. UE 2016/679 (GDPR) e del D.Lgs. 196/2003 come ' +
            'modificato, autorizzandosi reciprocamente al trattamento dei propri dati personali per le ' +
            'finalit\u00e0 del presente contratto.',
        },
        {
          n: '15.2',
          testo:
            'La Mandataria \u00e8 nominata Responsabile esterno del trattamento ai sensi dell\u2019art. 28 ' +
            'GDPR per i dati personali degli ospiti, dei quali acquisisce e gestisce i documenti di ' +
            'identit\u00e0 ai fini delle comunicazioni alla Questura tramite il Portale Alloggiati Web, ' +
            'secondo l\u2019informativa e l\u2019atto di nomina allegati sub lettera B.',
        },
      ],
    },
    {
      id: 'art16',
      numero: 'Art. 16',
      titolo: 'Forza maggiore',
      commi: [
        {
          n: '16.1',
          testo:
            'Nessuna delle parti \u00e8 responsabile dell\u2019inadempimento delle proprie obbligazioni ' +
            'qualora questo sia dovuto a cause di forza maggiore, tra cui calamit\u00e0 naturali, ' +
            'pandemie, provvedimenti normativi che impediscano la locazione breve, sospensioni dei ' +
            'servizi essenziali.',
        },
        {
          n: '16.2',
          testo:
            'In tale ipotesi, le parti si impegnano a una rinegoziazione in buona fede delle ' +
            'condizioni contrattuali.',
        },
      ],
    },
    {
      id: 'art17',
      numero: 'Art. 17',
      titolo: 'Riservatezza',
      commi: [
        {
          n: '17.1',
          testo:
            'Le parti si impegnano a mantenere riservate tutte le informazioni economiche, tecniche e ' +
            'commerciali di cui vengano a conoscenza in ragione del presente contratto, anche dopo la ' +
            'sua cessazione.',
        },
      ],
    },
    {
      id: 'art18',
      numero: 'Art. 18',
      titolo: 'Clausole risolutive espresse (art. 1456 c.c.)',
      commi: [
        {
          n: '18.1',
          testo:
            'Ai sensi dell\u2019art. 1456 c.c., il presente contratto si intender\u00e0 risolto di diritto, ' +
            'con effetto immediato, mediante dichiarazione della parte non inadempiente, in caso di:',
          elenco: [
            'violazione del patto di esclusiva (art. 3);',
            'ritardato pagamento delle somme dovute alla Mandataria oltre 30 giorni;',
            'falsit\u00e0 nelle dichiarazioni rese sulla propriet\u00e0 o sulla regolarit\u00e0 urbanistica, ' +
              'edilizia o catastale dell\u2019Immobile;',
            'annullamento, da parte del Mandante, di prenotazioni gi\u00e0 confermate, in violazione ' +
              'dell\u2019art. 10.5.',
          ],
        },
      ],
    },
    {
      id: 'art19',
      numero: 'Art. 19',
      titolo: 'Domicilio, foro competente e legge applicabile',
      commi: [
        {
          n: '19.1',
          testo:
            'Per ogni comunicazione le parti eleggono domicilio presso le rispettive sedi/residenze ' +
            'indicate in epigrafe.',
        },
        { n: '19.2', testo: 'Il presente contratto \u00e8 regolato dalla legge italiana.' },
        {
          n: '19.3',
          testo:
            'Per qualsiasi controversia derivante dall\u2019interpretazione, validit\u00e0 o esecuzione del ' +
            'presente contratto \u00e8 competente in via esclusiva il Foro di **{{foro}}**.',
        },
      ],
    },
  ],

  /**
   * Clausole ex artt. 1341-1342 c.c.
   * Ognuna richiede una spunta INDIVIDUALE nel form, non una spunta cumulativa.
   * Il campo `key` corrisponde alla chiave in caso.clausole1341.
   */
  clausoleVessatorie: {
    intro:
      'Ai sensi e per gli effetti degli artt. 1341 e 1342 c.c., il Mandante dichiara di aver letto, ' +
      'compreso e di approvare specificamente le seguenti clausole:',
    elenco: [
      { key: 'art3', label: 'Art. 3 \u2014 Esclusiva' },
      { key: 'art4', label: 'Art. 4.2-4.3 \u2014 Recesso e gestione prenotazioni post-recesso' },
      {
        key: 'art10',
        label:
          'Art. 10.3-10.5 \u2014 Limitazioni all\u2019utilizzo personale in alta stagione e divieto di ' +
          'annullamento prenotazioni',
      },
      {
        key: 'art11bis',
        label:
          'Art. 11-bis.4 \u2014 Commissione maggiorata per i servizi accessori di gestione del verde e ' +
          'della piscina',
      },
      { key: 'art14', label: 'Art. 14 \u2014 Propriet\u00e0 intellettuale del materiale fotografico' },
      { key: 'art18', label: 'Art. 18 \u2014 Clausole risolutive espresse' },
      { key: 'art19', label: 'Art. 19.3 \u2014 Foro competente esclusivo' },
    ],
  },

  glossario: {
    titolo: 'APPENDICE \u2014 Glossario e note tecniche',
    nota:
      'Sezione di servizio non contrattuale, a supporto della compilazione e della validazione del ' +
      'modello.',
    voci: [
      {
        termine: 'Canone di locazione puro',
        definizione:
          'base imponibile della ritenuta del 21% = canone lordo ospite \u2212 commissioni OTA \u2212 ' +
          'commissione Houzly. \u00c8 il valore riportato in Certificazione Unica (interpretazione AIGAB).',
      },
      {
        termine: 'Cedolare secca',
        definizione:
          'imposta sostitutiva IRPEF, opzionabile dal proprietario in sede di dichiarazione dei ' +
          'redditi; aliquota 21% sul primo immobile destinato a locazione breve, 26% dal secondo ' +
          '(verificare normativa vigente alla firma). La ritenuta del 21% operata dall\u2019intermediario ' +
          '\u00e8 a titolo d\u2019acconto e viene scomputata dall\u2019imposta dovuta secondo il regime ' +
          'prescelto (cedolare o ordinario).',
      },
      {
        termine: 'F24 \u2014 codice tributo 1919',
        definizione:
          'ritenuta operata all\u2019atto del pagamento al beneficiario di canoni/corrispettivi relativi ' +
          'a contratti di locazione breve.',
      },
      {
        termine: 'CU \u2014 Certificazione Unica',
        definizione:
          'documento fiscale annuale che il sostituto d\u2019imposta rilascia al sostituito e trasmette ' +
          'all\u2019Agenzia delle Entrate entro il 16 marzo.',
      },
      {
        termine: 'Modello 770',
        definizione: 'dichiarazione annuale del sostituto d\u2019imposta, entro il 31 ottobre.',
      },
      {
        termine: 'DAC7',
        definizione:
          'comunicazione dei gestori di piattaforma ex D.Lgs. 32/2023, entro il 31 gennaio.',
      },
      {
        termine: 'CIN',
        definizione:
          'Codice Identificativo Nazionale, obbligatorio per gli immobili in locazione breve.',
      },
    ],
  },

  /** Valori di default dei campi negoziabili — sovrascrivibili dalla pratica. */
  defaults: {
    commissione: '30% (trenta per cento)',
    commissioneMaggiorata: '35% (trentacinque per cento)',
    sogliaSpesa: '\u20ac 50,00 (cinquanta/00)',
    preavvisoRecesso: '6 (sei) mesi',
    altaStagione: '1 luglio \u2013 31 agosto',
    foro: 'Arezzo',
  },
};
