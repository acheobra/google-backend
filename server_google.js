const express = require('express');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// LOG GLOBAL SEGURO DE REQUISIÇÕES
// ============================================================
//
// Não registra Authorization, Service Role, chave privada ou purchaseToken
// completo. Os logs abaixo foram pensados para facilitar o diagnóstico no
// Render sem expor credenciais.
//
function mascararToken(valor) {
  const texto = String(valor || '').trim();

  if (!texto) return null;
  if (texto.length <= 10) return '***';

  return `${texto.slice(0, 4)}...${texto.slice(-6)}`;
}

function logGoogle(etapa, dados = {}) {
  const seguro = { ...dados };

  for (const chave of Object.keys(seguro)) {
    const nome = chave.toLowerCase();

    if (
      nome.includes('token') ||
      nome.includes('authorization') ||
      nome.includes('service_role') ||
      nome.includes('private_key')
    ) {
      seguro[chave] = mascararToken(seguro[chave]);
    }
  }

  console.log(
    `[GOOGLE][${new Date().toISOString()}][${etapa}]`,
    JSON.stringify(seguro)
  );
}

app.use((req, res, next) => {
  const inicio = Date.now();
  const requestId =
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  req.googleRequestId = requestId;

  logGoogle('HTTP_IN', {
    request_id: requestId,
    method: req.method,
    path: req.path,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    user_agent: req.headers['user-agent'] || null,
  });

  res.on('finish', () => {
    logGoogle('HTTP_OUT', {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duracao_ms: Date.now() - inicio,
    });
  });

  next();
});


// ============================================================
// CORS
// ============================================================

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

// ============================================================
// PORTA
// ============================================================

const PORT = process.env.PORT || 10000;


// ============================================================
// DIAGNÓSTICO SEGURO
// ============================================================
//
// Variável opcional esperada no Render:
//
// GOOGLE_DIAGNOSTIC_KEY
//
// As rotas /google/diagnostico/* exigem o header:
//
// x-diagnostic-key: <GOOGLE_DIAGNOSTIC_KEY>
//
// Isso evita deixar rotas técnicas abertas ao público.
// ============================================================

function obterDiagnosticKey() {
  return String(
    process.env.GOOGLE_DIAGNOSTIC_KEY || ''
  ).trim();
}

function protegerDiagnostico(req, res, next) {
  const chaveEsperada =
    obterDiagnosticKey();

  if (!chaveEsperada) {
    return res
      .status(503)
      .json({
        success: false,
        error:
          'GOOGLE_DIAGNOSTIC_KEY não configurada no Render.',
      });
  }

  const chaveRecebida =
    String(
      req.headers['x-diagnostic-key'] || ''
    ).trim();

  if (
    !chaveRecebida ||
    chaveRecebida !== chaveEsperada
  ) {
    return res
      .status(401)
      .json({
        success: false,
        error:
          'Chave de diagnóstico inválida.',
      });
  }

  next();
}

// ============================================================
// GOOGLE PLAY - CONFIGURAÇÃO
// ============================================================
//
// Variáveis esperadas no Render:
//
// GOOGLE_PACKAGE_NAME
// GOOGLE_SERVICE_ACCOUNT_JSON
//
// GOOGLE_SERVICE_ACCOUNT_JSON deve conter o JSON COMPLETO da
// conta de serviço em uma única variável de ambiente.
//
// Exemplo de package:
// br.com.acheobra.app
//
// NUNCA coloque a chave da conta de serviço no Flutter.
// ============================================================

const GOOGLE_ANDROID_PUBLISHER_SCOPE =
  'https://www.googleapis.com/auth/androidpublisher';

const GOOGLE_ANDROID_PUBLISHER_BASE_URL =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';

function obterGooglePackageName() {
  const packageName =
    process.env.GOOGLE_PACKAGE_NAME?.trim();

  if (!packageName) {
    throw new Error(
      'GOOGLE_PACKAGE_NAME não configurado no Render.'
    );
  }

  return packageName;
}

function obterCredenciaisContaServicoGoogle() {
  const jsonTexto =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();

  if (!jsonTexto) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON não configurado no Render.'
    );
  }

  try {
    const credenciais =
      JSON.parse(jsonTexto);

    if (
      !credenciais.client_email ||
      !credenciais.private_key
    ) {
      throw new Error(
        'JSON da conta de serviço não possui client_email/private_key.'
      );
    }

    return credenciais;

  } catch (error) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON inválido: ${error.message}`
    );
  }
}

async function obterAccessTokenGoogle() {
  const credentials =
    obterCredenciaisContaServicoGoogle();

  const auth =
    new GoogleAuth({
      credentials,
      scopes: [
        GOOGLE_ANDROID_PUBLISHER_SCOPE,
      ],
    });

  const client =
    await auth.getClient();

  const tokenResposta =
    await client.getAccessToken();

  const accessToken =
    typeof tokenResposta === 'string'
      ? tokenResposta
      : tokenResposta?.token;

  if (!accessToken) {
    throw new Error(
      'Não foi possível obter access token da Google Play Developer API.'
    );
  }

  return accessToken;
}

// ============================================================
// SUPABASE - CONFIGURAÇÃO
// ============================================================
//
// Variáveis esperadas no Render:
//
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
//
// A SERVICE_ROLE fica SOMENTE no backend.
// ============================================================

function obterConfiguracaoSupabase() {
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim();

  const supabaseServiceRoleKey =
    process.env
      .SUPABASE_SERVICE_ROLE_KEY
      ?.trim();

  if (!supabaseUrl) {
    throw new Error(
      'SUPABASE_URL não configurado no Render.'
    );
  }

  if (!supabaseServiceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY não configurado no Render.'
    );
  }

  return {
    supabaseUrl:
      supabaseUrl.replace(/\/+$/, ''),
    supabaseServiceRoleKey,
  };
}

function obterHeadersSupabase() {
  const {
    supabaseServiceRoleKey,
  } = obterConfiguracaoSupabase();

  return {
    apikey:
      supabaseServiceRoleKey,

    Authorization:
      `Bearer ${supabaseServiceRoleKey}`,

    'Content-Type':
      'application/json',
  };
}

// ============================================================
// SUPABASE - USUÁRIO AUTENTICADO
// ============================================================
//
// O Flutter envia:
// Authorization: Bearer <access_token Supabase>
//
// Nunca confiamos somente no usuario_id recebido no body.
// ============================================================

async function obterUsuarioSupabaseDoBearer(req) {
  const authorization =
    req.headers.authorization || '';

  if (
    !authorization
      .toLowerCase()
      .startsWith('bearer ')
  ) {
    return null;
  }

  const token =
    authorization
      .substring(7)
      .trim();

  if (!token) {
    return null;
  }

  const {
    supabaseUrl,
    supabaseServiceRoleKey,
  } = obterConfiguracaoSupabase();

  const response =
    await axios({
      method: 'GET',

      url:
        `${supabaseUrl}/auth/v1/user`,

      headers: {
        apikey:
          supabaseServiceRoleKey,

        Authorization:
          `Bearer ${token}`,
      },

      timeout:
        30000,
    });

  return response.data || null;
}

// ============================================================
// SUPABASE - CONSULTAR PLANO
// ============================================================

async function buscarPlanoGooglePorId(planoId) {
  const {
    supabaseUrl,
  } = obterConfiguracaoSupabase();

  const response =
    await axios({
      method: 'GET',

      url:
        `${supabaseUrl}/rest/v1/tab_planos`,

      params: {
        select:
          'id,nome_plano,tipo_usuario,google_product_id,google_product_id_avulso,google_base_plan_id,google_ativo',

        id:
          `eq.${planoId}`,

        limit:
          1,
      },

      headers:
        obterHeadersSupabase(),

      timeout:
        30000,
    });

  return Array.isArray(response.data)
    ? response.data[0] || null
    : null;
}

// ============================================================
// SUPABASE - ASSINATURAS GOOGLE
// ============================================================

async function inserirOuAtualizarAssinaturaGoogle(dados) {
  const {
    supabaseUrl,
  } = obterConfiguracaoSupabase();

  const response =
    await axios({
      method: 'POST',

      url:
        `${supabaseUrl}/rest/v1/tab_assinaturas_google`,

      params: {
        on_conflict:
          'purchase_token',
      },

      headers: {
        ...obterHeadersSupabase(),

        Prefer:
          'resolution=merge-duplicates,return=representation',
      },

      data:
        dados,

      timeout:
        30000,
    });

  return Array.isArray(response.data)
    ? response.data[0] || null
    : null;
}

async function buscarAssinaturaGooglePorToken(
  purchaseToken
) {
  const {
    supabaseUrl,
  } = obterConfiguracaoSupabase();

  const response =
    await axios({
      method: 'GET',

      url:
        `${supabaseUrl}/rest/v1/tab_assinaturas_google`,

      params: {
        select:
          '*',

        purchase_token:
          `eq.${purchaseToken}`,

        limit:
          1,
      },

      headers:
        obterHeadersSupabase(),

      timeout:
        30000,
    });

  return Array.isArray(response.data)
    ? response.data[0] || null
    : null;
}


// ============================================================
// SUPABASE - TROCA DE PLANOS GOOGLE
// ============================================================

function obterNomeBasePlano(nomePlano) {
  return String(nomePlano || '')
    .replace(/\s*[-–—]\s*(recorrente|avulso)\s*$/i, '')
    .trim();
}

async function atualizarPlanoAtivoUsuarioGoogle({
  usuarioId,
  plano,
  recorrente,
  dataAtivacao,
}) {
  const { supabaseUrl } = obterConfiguracaoSupabase();

  const payload = {
    nome_plano_ativo: obterNomeBasePlano(plano?.nome_plano),
    id_plano_atual: plano.id,
    plano_id: plano.id,
    recorrente: Boolean(recorrente),
    plano_data_ativacao: dataAtivacao || new Date().toISOString(),
  };

  logGoogle('SUPABASE_USUARIO_ATUALIZAR_INICIO', {
    usuario_id: usuarioId,
    plano_id: plano.id,
    recorrente: Boolean(recorrente),
  });

  const response = await axios({
    method: 'PATCH',
    url: `${supabaseUrl}/rest/v1/tab_usuarios`,
    params: {
      id: `eq.${usuarioId}`,
    },
    headers: {
      ...obterHeadersSupabase(),
      Prefer: 'return=representation',
    },
    data: payload,
    timeout: 30000,
  });

  const atualizado =
    Array.isArray(response.data) ? response.data[0] || null : null;

  if (!atualizado) {
    throw new Error(
      'Não foi possível sincronizar o plano ativo em tab_usuarios.'
    );
  }

  logGoogle('SUPABASE_USUARIO_ATUALIZADO', {
    usuario_id: usuarioId,
    plano_id: plano.id,
    recorrente: Boolean(recorrente),
  });

  return atualizado;
}

// ============================================================
// CANCELAMENTO IMEDIATO: RETORNAR USUÁRIO AO PLANO GRÁTIS
// ============================================================
function normalizarTextoPlanoGoogle(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

async function buscarPlanoGratisGoogleDoMesmoTipo(planoAtual) {
  const { supabaseUrl } = obterConfiguracaoSupabase();
  const response = await axios({
    method: 'GET',
    url: `${supabaseUrl}/rest/v1/tab_planos`,
    params: {
      select: 'id,nome_plano,tipo_usuario',
      limit: 500,
    },
    headers: obterHeadersSupabase(),
    timeout: 30000,
  });

  const todosPlanos = Array.isArray(response.data) ? response.data : [];
  const planos = todosPlanos.filter((p) =>
    normalizarTextoPlanoGoogle(p?.nome_plano).includes('gratis')
  );
  if (!planos.length) {
    throw new Error('Nenhum plano Grátis foi encontrado em tab_planos.');
  }

  const tipoAtual = normalizarTextoPlanoGoogle(planoAtual?.tipo_usuario);
  let gratis = null;

  if (tipoAtual) {
    gratis = planos.find((p) =>
      normalizarTextoPlanoGoogle(p?.tipo_usuario) === tipoAtual
    ) || planos.find((p) => {
      const tipoGratis = normalizarTextoPlanoGoogle(p?.tipo_usuario);
      return tipoGratis && (tipoGratis.includes(tipoAtual) || tipoAtual.includes(tipoGratis));
    });
  }

  // Se há tipos definidos no plano pago, não associamos silenciosamente
  // um plano grátis de outro tipo de usuário.
  if (!gratis && tipoAtual) {
    throw new Error(`Não foi encontrado plano Grátis para o tipo de usuário "${planoAtual.tipo_usuario}".`);
  }
  gratis = gratis || planos[0];

  if (gratis?.id == null || !String(gratis.nome_plano || '').trim()) {
    throw new Error('O cadastro do plano Grátis não possui id/nome_plano válido.');
  }
  return gratis;
}

async function retornarUsuarioAoPlanoGratisGoogle({ usuarioId, planoAtual }) {
  const { supabaseUrl } = obterConfiguracaoSupabase();
  const planoGratis = await buscarPlanoGratisGoogleDoMesmoTipo(planoAtual);
  const payload = {
    nome_plano_ativo: obterNomeBasePlano(planoGratis.nome_plano),
    id_plano_atual: planoGratis.id,
    plano_id: planoGratis.id,
    recorrente: false,
    plano_data_ativacao: null,
  };

  const response = await axios({
    method: 'PATCH',
    url: `${supabaseUrl}/rest/v1/tab_usuarios`,
    params: { id: `eq.${usuarioId}` },
    headers: {
      ...obterHeadersSupabase(),
      Prefer: 'return=representation',
    },
    data: payload,
    timeout: 30000,
  });

  const usuarioAtualizado = Array.isArray(response.data) ? response.data[0] : null;
  if (!usuarioAtualizado) {
    throw new Error('O cancelamento foi processado, mas não foi possível atualizar tab_usuarios para o plano Grátis.');
  }

  logGoogle('USUARIO_RETORNOU_AO_GRATIS_APOS_CANCELAMENTO', {
    usuario_id: usuarioId,
    plano_gratis_id: planoGratis.id,
    nome_plano_gratis: planoGratis.nome_plano,
  });
  return { planoGratis, usuarioAtualizado };
}

async function atualizarAssinaturaGooglePorToken(
  purchaseToken,
  dados
) {
  const { supabaseUrl } = obterConfiguracaoSupabase();

  const response = await axios({
    method: 'PATCH',
    url: `${supabaseUrl}/rest/v1/tab_assinaturas_google`,
    params: {
      purchase_token: `eq.${purchaseToken}`,
    },
    headers: {
      ...obterHeadersSupabase(),
      Prefer: 'return=representation',
    },
    data: dados,
    timeout: 30000,
  });

  return Array.isArray(response.data)
    ? response.data[0] || null
    : null;
}

async function buscarAssinaturasGoogleDoUsuario(usuarioId) {
  const { supabaseUrl } = obterConfiguracaoSupabase();

  const response = await axios({
    method: 'GET',
    url: `${supabaseUrl}/rest/v1/tab_assinaturas_google`,
    params: {
      select: '*',
      usuario_id: `eq.${usuarioId}`,
      order: 'updated_at.desc',
      limit: 50,
    },
    headers: obterHeadersSupabase(),
    timeout: 30000,
  });

  return Array.isArray(response.data) ? response.data : [];
}

async function buscarAssinaturaGoogleAnteriorSegura({
  usuarioId,
  purchaseTokenAnterior,
}) {
  const token = String(purchaseTokenAnterior || '').trim();

  if (!token) return null;

  const registro = await buscarAssinaturaGooglePorToken(token);

  if (!registro) return null;

  if (String(registro.usuario_id || '') !== String(usuarioId)) {
    throw new Error(
      'O purchase_token_anterior não pertence ao usuário autenticado.'
    );
  }

  return registro;
}

// ============================================================
// GOOGLE PLAY - PRODUTO AVULSO V2
// ============================================================

async function consultarProdutoAvulsoGoogle(purchaseToken) {
  const packageName = obterGooglePackageName();
  const accessToken = await obterAccessTokenGoogle();

  logGoogle('GOOGLE_AVULSO_CONSULTA', {
    package_name: packageName,
    purchase_token: purchaseToken,
  });

  const response = await axios({
    method: 'GET',
    url:
      `${GOOGLE_ANDROID_PUBLISHER_BASE_URL}` +
      `/applications/${encodeURIComponent(packageName)}` +
      `/purchases/productsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return response.data || null;
}

function localizarLineItemProdutoAvulso(compraGoogle, googleProductId) {
  const itens = Array.isArray(compraGoogle?.productLineItem)
    ? compraGoogle.productLineItem
    : [];

  return (
    itens.find(
      (item) =>
        String(item?.productId || '').trim() ===
        String(googleProductId || '').trim()
    ) || null
  );
}

function mapearStatusAvulsoGoogle(compraGoogle) {
  const estado = String(
    compraGoogle?.purchaseStateContext?.purchaseState || ''
  )
    .trim()
    .toUpperCase();

  if (estado === 'PURCHASED') {
    return {
      statusGoogle: estado,
      statusInterno: 'pago',
      pago: true,
      processando: false,
    };
  }

  if (estado === 'PENDING') {
    return {
      statusGoogle: estado,
      statusInterno: 'pagamento_pendente',
      pago: false,
      processando: true,
    };
  }

  if (estado === 'CANCELLED') {
    return {
      statusGoogle: estado,
      statusInterno: 'cancelado',
      pago: false,
      processando: false,
    };
  }

  return {
    statusGoogle: estado || 'DESCONHECIDO',
    statusInterno: 'desconhecido',
    pago: false,
    processando: false,
  };
}

// ============================================================
// SELO DE VERIFICAÇÃO - COMPRA AVULSA INDEPENDENTE DOS PLANOS
// ============================================================
// A tabela tab_pagamentos_selo_google é criada pelo SQL entregue à parte.
// Nenhum campo de tab_usuarios ou tab_assinaturas_google é alterado.

const GOOGLE_SELO_PRODUCT_ID = 'selo_verificacao_avulso';

async function buscarConfiguracaoSeloGoogle(seloId) {
  const { supabaseUrl } = obterConfiguracaoSupabase();
  const response = await axios({
    method: 'GET',
    url: `${supabaseUrl}/rest/v1/tab_planos_selos`,
    params: { select: 'id', id: `eq.${seloId}`, limit: 1 },
    headers: obterHeadersSupabase(), timeout: 30000,
  });
  return Array.isArray(response.data) ? response.data[0] || null : null;
}

async function buscarPagamentoSeloPorToken(purchaseToken) {
  const { supabaseUrl } = obterConfiguracaoSupabase();
  const response = await axios({
    method: 'GET',
    url: `${supabaseUrl}/rest/v1/tab_pagamentos_selo_google`,
    params: { select: '*', purchase_token: `eq.${purchaseToken}`, limit: 1 },
    headers: obterHeadersSupabase(), timeout: 30000,
  });
  return Array.isArray(response.data) ? response.data[0] || null : null;
}

async function salvarPagamentoSeloGoogle(dados) {
  const { supabaseUrl } = obterConfiguracaoSupabase();
  const response = await axios({
    method: 'POST',
    url: `${supabaseUrl}/rest/v1/tab_pagamentos_selo_google`,
    params: { on_conflict: 'purchase_token' },
    headers: {
      ...obterHeadersSupabase(),
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    data: dados, timeout: 30000,
  });
  return Array.isArray(response.data) ? response.data[0] || null : null;
}

async function reconhecerCompraSeloGoogle(purchaseToken, productId) {
  const packageName = obterGooglePackageName();
  const accessToken = await obterAccessTokenGoogle();
  await axios({
    method: 'POST',
    url: `${GOOGLE_ANDROID_PUBLISHER_BASE_URL}` +
      `/applications/${encodeURIComponent(packageName)}` +
      `/purchases/products/${encodeURIComponent(productId)}` +
      `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    data: {}, timeout: 30000,
  });
}

async function validarPagamentoSeloGoogle({ req, res, usuario, planoId, purchaseToken, googleProductIdRecebido }) {
  const requestId = req.googleRequestId || 'sem-id';
  if (!planoId || !purchaseToken) {
    return res.status(400).json({ success: false, validado: false, error: 'plano_id e purchase_token são obrigatórios.' });
  }
  if (googleProductIdRecebido && googleProductIdRecebido !== GOOGLE_SELO_PRODUCT_ID) {
    return res.status(409).json({ success: false, validado: false, error: 'Produto Google diferente do selo de verificação.' });
  }
  const selo = await buscarConfiguracaoSeloGoogle(planoId);
  if (!selo) {
    return res.status(404).json({ success: false, validado: false, error: 'Configuração do selo não encontrada em tab_planos_selos.' });
  }

  // Evita usar o token de um plano ou de outro usuário no pagamento do selo.
  const [registroSeloAnterior, registroPlanoAnterior] = await Promise.all([
    buscarPagamentoSeloPorToken(purchaseToken),
    buscarAssinaturaGooglePorToken(purchaseToken),
  ]);
  if (registroPlanoAnterior || (registroSeloAnterior &&
      (String(registroSeloAnterior.usuario_id) !== String(usuario.id) ||
       String(registroSeloAnterior.selo_id) !== String(selo.id)))) {
    return res.status(409).json({ success: false, validado: false, error: 'Este token já está vinculado a outra compra ou usuário.' });
  }

  const compraGoogle = await consultarProdutoAvulsoGoogle(purchaseToken);
  const item = localizarLineItemProdutoAvulso(compraGoogle, GOOGLE_SELO_PRODUCT_ID);
  if (!item) {
    return res.status(409).json({ success: false, validado: false, error: 'O Google não confirmou o produto selo_verificacao_avulso para este token.' });
  }
  const estado = mapearStatusAvulsoGoogle(compraGoogle);
  if (!estado.pago) {
    logGoogle('SELO_COMPRA_NAO_PAGA', { request_id: requestId, status_google: estado.statusGoogle });
    return res.status(estado.processando ? 202 : 409).json({
      success: estado.processando, validado: false, purchase_valid: false,
      pago: false, processando: estado.processando, status: estado.statusInterno,
      status_google: estado.statusGoogle,
      message: estado.processando ? 'Pagamento do selo ainda pendente no Google.' : 'Pagamento do selo não confirmado pelo Google.',
    });
  }

  const agoraIso = new Date().toISOString();
  const orderId = compraGoogle?.orderId ? String(compraGoogle.orderId) : null;
  const registro = await salvarPagamentoSeloGoogle({
    usuario_id: usuario.id,
    selo_id: selo.id,
    google_product_id: GOOGLE_SELO_PRODUCT_ID,
    purchase_token: purchaseToken,
    google_order_id: orderId,
    status_pagamento: 'pago',
    pago_em: compraGoogle?.purchaseCompletionTime || agoraIso,
    updated_at: agoraIso,
  });
  if (!registro) throw new Error('Não foi possível registrar o pagamento do selo.');

  // Reconhecimento obrigatório de produto não consumível; falha não invalida
  // o pagamento já confirmado e registrado. Não consumir o produto.
  const acknowledgementState = String(compraGoogle?.acknowledgementState || '');
  if (acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
    try {
      await reconhecerCompraSeloGoogle(purchaseToken, GOOGLE_SELO_PRODUCT_ID);
    } catch (error) {
      logGoogle('SELO_ACK_ERRO', { request_id: requestId, http_status: error.response?.status || null, erro: error.response?.data?.error?.message || error.message });
    }
  }

  logGoogle('SELO_PAGAMENTO_CONFIRMADO', { request_id: requestId, usuario_id: usuario.id, selo_id: selo.id, google_order_id: orderId });
  // A aprovação do selo NÃO ocorre aqui: o Flutter ainda precisa enviar
  // documentos e o administrador ainda precisa validá-los.
  return res.json({
    success: true, validado: true, purchase_valid: true,
    pagamento_confirmado: true, pago: true, plano_ativo: false,
    assinatura_ativa: false, recorrente: false, tipo_compra: 'avulso',
    status: 'pago', status_google: estado.statusGoogle,
    google_product_id: GOOGLE_SELO_PRODUCT_ID,
    google_order_id: orderId, selo_id: selo.id,
    compra: registro,
  });
}

// ============================================================
// GOOGLE PLAY - CANCELAR RENOVAÇÃO DE ASSINATURA V2
// ============================================================
//
// Usado em recorrente -> avulso somente DEPOIS de o novo pagamento
// avulso estar confirmado.
//
// USER_REQUESTED_STOP_RENEWALS interrompe a próxima renovação sem
// reembolsar o período já pago.
//
async function cancelarRenovacaoAssinaturaGoogleV2(purchaseToken) {
  const token = String(purchaseToken || '').trim();

  if (!token) {
    throw new Error('purchaseToken da assinatura anterior não informado.');
  }

  const packageName = obterGooglePackageName();
  const accessToken = await obterAccessTokenGoogle();

  logGoogle('GOOGLE_ASSINATURA_CANCELAR_INICIO', {
    package_name: packageName,
    purchase_token: token,
    cancellation_type: 'USER_REQUESTED_STOP_RENEWALS',
  });

  await axios({
    method: 'POST',
    url:
      `${GOOGLE_ANDROID_PUBLISHER_BASE_URL}` +
      `/applications/${encodeURIComponent(packageName)}` +
      `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}:cancel`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    data: {
      cancellationContext: {
        cancellationType: 'USER_REQUESTED_STOP_RENEWALS',
      },
    },
    timeout: 30000,
  });

  logGoogle('GOOGLE_ASSINATURA_CANCELAR_OK', {
    purchase_token: token,
  });

  return true;
}

async function marcarAssinaturaAnteriorComoSubstituida({
  purchaseTokenAnterior,
  motivo,
}) {
  const token = String(purchaseTokenAnterior || '').trim();
  if (!token) return null;

  return atualizarAssinaturaGooglePorToken(token, {
    status_assinatura: motivo || 'substituido',
    tipo_compra: 'recorrente',
    recorrente: true,
    cancelado_em: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function extrairLinkedPurchaseToken(assinaturaGoogle) {
  const token = String(
    assinaturaGoogle?.linkedPurchaseToken || ''
  ).trim();

  return token || null;
}


// ============================================================
// HELPERS DE DIAGNÓSTICO DO SUPABASE
// ============================================================

async function diagnosticarSupabase() {
  const {
    supabaseUrl,
  } = obterConfiguracaoSupabase();

  const headers =
    obterHeadersSupabase();

  const [
    planosResponse,
    assinaturasResponse,
  ] =
    await Promise.all([
      axios({
        method: 'GET',

        url:
          `${supabaseUrl}/rest/v1/tab_planos`,

        params: {
          select:
            'id,nome_plano,google_product_id,google_product_id_avulso,google_base_plan_id,google_ativo',

          limit:
            5,
        },

        headers,

        timeout:
          30000,
      }),

      axios({
        method: 'GET',

        url:
          `${supabaseUrl}/rest/v1/tab_assinaturas_google`,

        params: {
          select:
            'id',

          limit:
            1,
        },

        headers,

        timeout:
          30000,
      }),
    ]);

  return {
    tab_planos:
      {
        acessivel:
          true,

        quantidade_amostra:
          Array.isArray(
            planosResponse.data
          )
            ? planosResponse.data.length
            : 0,

        planos:
          Array.isArray(
            planosResponse.data
          )
            ? planosResponse.data
            : [],
      },

    tab_assinaturas_google:
      {
        acessivel:
          true,

        consulta_realizada:
          true,

        quantidade_amostra:
          Array.isArray(
            assinaturasResponse.data
          )
            ? assinaturasResponse.data.length
            : 0,
      },
  };
}

async function verificarUsuarioExiste(usuarioId) {
  const {
    supabaseUrl,
  } = obterConfiguracaoSupabase();

  const response =
    await axios({
      method: 'GET',

      url:
        `${supabaseUrl}/rest/v1/tab_usuarios`,

      params: {
        select:
          'id',

        id:
          `eq.${usuarioId}`,

        limit:
          1,
      },

      headers:
        obterHeadersSupabase(),

      timeout:
        30000,
    });

  return (
    Array.isArray(response.data) &&
    response.data.length > 0
  );
}

async function testarGravacaoAssinaturaGoogle({
  usuarioId,
  planoId,
}) {
  const {
    supabaseUrl,
  } = obterConfiguracaoSupabase();

  const purchaseToken =
    `DIAGNOSTICO_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;

  const agoraIso =
    new Date()
      .toISOString();

  const payload = {
    usuario_id:
      usuarioId,

    plano_id:
      planoId,

    google_product_id:
      'diagnostico_google',

    google_base_plan_id:
      'diagnostico',

    tipo_compra:
      'recorrente',

    recorrente:
      true,

    purchase_token:
      purchaseToken,

    google_order_id:
      null,

    status_assinatura:
      'teste_diagnostico',

    acknowledgement_state:
      null,

    auto_renovacao:
      false,

    data_inicio:
      agoraIso,

    data_expiracao:
      agoraIso,

    data_ultimo_pagamento:
      null,

    cancelado_em:
      null,

    updated_at:
      agoraIso,
  };

  const insertResponse =
    await axios({
      method: 'POST',

      url:
        `${supabaseUrl}/rest/v1/tab_assinaturas_google`,

      headers: {
        ...obterHeadersSupabase(),

        Prefer:
          'return=representation',
      },

      data:
        payload,

      timeout:
        30000,
    });

  const inserido =
    Array.isArray(
      insertResponse.data
    )
      ? insertResponse.data[0] || null
      : null;

  // Limpeza imediata para não deixar sujeira na tabela.
  await axios({
    method: 'DELETE',

    url:
      `${supabaseUrl}/rest/v1/tab_assinaturas_google`,

    params: {
      purchase_token:
        `eq.${purchaseToken}`,
    },

    headers:
      obterHeadersSupabase(),

    timeout:
      30000,
  });

  return {
    inseriu:
      Boolean(inserido),

    removeu_apos_teste:
      true,

    purchase_token_teste:
      purchaseToken,
  };
}

// ============================================================
// GOOGLE PLAY - CONSULTAR ASSINATURA V2
// ============================================================
//
// Endpoint atual:
//
// GET
// /applications/{packageName}/purchases/subscriptionsv2/tokens/{token}
//
// Não usa o endpoint legado subscriptions.get.
// ============================================================

async function consultarAssinaturaGoogle(
  purchaseToken
) {
  const packageName =
    obterGooglePackageName();

  const accessToken =
    await obterAccessTokenGoogle();

  const response =
    await axios({
      method:
        'GET',

      url:
        `${GOOGLE_ANDROID_PUBLISHER_BASE_URL}` +
        `/applications/${encodeURIComponent(packageName)}` +
        `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,

      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        'Content-Type':
          'application/json',
      },

      timeout:
        30000,
    });

  return response.data || null;
}

// ============================================================
// GOOGLE PLAY - INTERPRETAÇÃO DA ASSINATURA
// ============================================================

function mapearStatusGoogleParaInterno(
  subscriptionState,
  expiryTime
) {
  const status =
    String(
      subscriptionState || ''
    )
      .trim()
      .toUpperCase();

  const expiracao =
    expiryTime
      ? new Date(expiryTime)
      : null;

  const expiracaoValida =
    expiracao &&
    !Number.isNaN(
      expiracao.getTime()
    );

  const aindaTemAcesso =
    expiracaoValida &&
    expiracao.getTime() >
      Date.now();

  switch (status) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return {
        statusInterno:
          'ativo',
        assinaturaAtiva:
          true,
      };

    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return {
        statusInterno:
          'carencia',
        assinaturaAtiva:
          true,
      };

    case 'SUBSCRIPTION_STATE_CANCELED':
      //
      // Cancelada para renovação, mas o usuário pode continuar
      // com acesso até expiryTime.
      //
      return {
        statusInterno:
          aindaTemAcesso
            ? 'cancelado_com_acesso'
            : 'cancelado',
        assinaturaAtiva:
          Boolean(aindaTemAcesso),
      };

    case 'SUBSCRIPTION_STATE_PENDING':
      return {
        statusInterno:
          'pagamento_pendente',
        assinaturaAtiva:
          false,
      };

    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return {
        statusInterno:
          'suspenso',
        assinaturaAtiva:
          false,
      };

    case 'SUBSCRIPTION_STATE_PAUSED':
      return {
        statusInterno:
          'pausado',
        assinaturaAtiva:
          false,
      };

    case 'SUBSCRIPTION_STATE_EXPIRED':
      return {
        statusInterno:
          'expirado',
        assinaturaAtiva:
          false,
      };

    default:
      return {
        statusInterno:
          'desconhecido',
        assinaturaAtiva:
          false,
      };
  }
}

function localizarLineItemDoProduto(
  assinaturaGoogle,
  googleProductId
) {
  const lineItems =
    Array.isArray(
      assinaturaGoogle?.lineItems
    )
      ? assinaturaGoogle.lineItems
      : [];

  return (
    lineItems.find(
      (item) =>
        String(
          item?.productId || ''
        ).trim() === googleProductId
    ) ||
    null
  );
}

function extrairBasePlanId(lineItem) {
  return String(
    lineItem?.offerDetails?.basePlanId ||
    ''
  ).trim();
}

function extrairAutoRenovacao(lineItem) {
  const valor =
    lineItem
      ?.autoRenewingPlan
      ?.autoRenewEnabled;

  return typeof valor === 'boolean'
    ? valor
    : null;
}

function extrairOrderId(lineItem) {
  return (
    lineItem?.latestSuccessfulOrderId
      ? String(
          lineItem.latestSuccessfulOrderId
        ).trim()
      : null
  );
}

// ============================================================
// TESTE DE AUTENTICAÇÃO GOOGLE PLAY
// ============================================================
//
// GET /google/test-auth
//
// Testa se a Service Account consegue autenticar no Google.
// Não expõe access token nem chave privada.
// ============================================================

app.get(
  '/google/test-auth',

  async (req, res) => {
    try {
      await obterAccessTokenGoogle();

      console.log(
        '>>> TESTE GOOGLE: autenticação com Service Account OK'
      );

      return res.json({
        success:
          true,

        google_auth:
          true,

        message:
          'Autenticação com a conta de serviço Google realizada com sucesso.',
      });

    } catch (error) {
      console.error(
        '>>> ERRO NO TESTE DE AUTENTICAÇÃO GOOGLE:',
        error.response?.data ||
        error.message
      );

      const statusHttp =
        error.response?.status ||
        500;

      let mensagem =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message ||
        'Erro ao autenticar no Google.';

      if (
        typeof mensagem !==
        'string'
      ) {
        mensagem =
          JSON.stringify(
            mensagem
          );
      }

      return res
        .status(statusHttp)
        .json({
          success:
            false,

          google_auth:
            false,

          error:
            mensagem,
        });
    }
  }
);

// ============================================================
// DIAGNÓSTICO COMPLETO - GOOGLE + SUPABASE
// ============================================================

app.get(
  '/google/diagnostico',

  protegerDiagnostico,

  async (req, res) => {
    const resultado = {
      success:
        false,

      google:
        {
          auth:
            false,
        },

      supabase:
        {
          ok:
            false,
        },

      configuracao:
        {
          package_name:
            Boolean(
              process.env.GOOGLE_PACKAGE_NAME
            ),

          service_account:
            Boolean(
              process.env.GOOGLE_SERVICE_ACCOUNT_JSON
            ),

          supabase_url:
            Boolean(
              process.env.SUPABASE_URL
            ),

          supabase_secret:
            Boolean(
              process.env.SUPABASE_SERVICE_ROLE_KEY
            ),
        },
    };

    try {
      await obterAccessTokenGoogle();

      resultado.google.auth =
        true;

      const diagnosticoSupabase =
        await diagnosticarSupabase();

      resultado.supabase =
        {
          ok:
            true,

          ...diagnosticoSupabase,
        };

      resultado.success =
        true;

      return res.json(
        resultado
      );

    } catch (error) {
      console.error(
        '>>> ERRO NO DIAGNÓSTICO COMPLETO:',
        error.response?.data ||
        error.message
      );

      resultado.error =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message ||
        'Erro desconhecido no diagnóstico.';

      return res
        .status(
          error.response?.status ||
          500
        )
        .json(
          resultado
        );
    }
  }
);

// ============================================================
// DIAGNÓSTICO - ESTRUTURA DE UM PLANO GOOGLE
// ============================================================

app.post(
  '/google/diagnostico/plano',

  protegerDiagnostico,

  async (req, res) => {
    try {
      const planoId =
        String(
          req.body?.plano_id ||
          ''
        ).trim();

      if (!planoId) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              'plano_id é obrigatório.',
          });
      }

      const plano =
        await buscarPlanoGooglePorId(
          planoId
        );

      if (!plano) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              'Plano não encontrado.',
          });
      }

      const googleProductId =
        String(
          plano.google_product_id ||
          ''
        ).trim();

      const googleProductIdAvulso =
        String(
          plano.google_product_id_avulso ||
          ''
        ).trim();

      const googleBasePlanId =
        String(
          plano.google_base_plan_id ||
          ''
        ).trim();

      const configuradoRecorrente =
        plano.google_ativo === true &&
        googleProductId.length > 0 &&
        googleBasePlanId.length > 0;

      const configuradoAvulso =
        plano.google_ativo === true &&
        googleProductIdAvulso.length > 0;

      const configurado =
        configuradoRecorrente || configuradoAvulso;

      return res.json({
        success:
          true,

        configurado_para_google:
          configurado,

        plano:
          {
            id:
              plano.id,

            nome_plano:
              plano.nome_plano,

            google_ativo:
              plano.google_ativo,

            google_product_id:
              googleProductId || null,

            google_product_id_avulso:
              googleProductIdAvulso || null,

            google_base_plan_id:
              googleBasePlanId || null,

            configurado_recorrente:
              configuradoRecorrente,

            configurado_avulso:
              configuradoAvulso,
          },

        message:
          configurado
            ? 'Plano pronto para integração Google.'
            : 'Plano ainda possui configuração Google pendente.',
      });

    } catch (error) {
      console.error(
        '>>> ERRO NO DIAGNÓSTICO DO PLANO:',
        error.response?.data ||
        error.message
      );

      return res
        .status(
          error.response?.status ||
          500
        )
        .json({
          success:
            false,

          error:
            error.response?.data?.error?.message ||
            error.response?.data?.message ||
            error.message,
        });
    }
  }
);

// ============================================================
// DIAGNÓSTICO - TESTE CONTROLADO DE GRAVAÇÃO
// ============================================================

app.post(
  '/google/diagnostico/testar-gravacao',

  protegerDiagnostico,

  async (req, res) => {
    try {
      const usuarioId =
        String(
          req.body?.usuario_id ||
          ''
        ).trim();

      const planoId =
        String(
          req.body?.plano_id ||
          ''
        ).trim();

      if (
        !usuarioId ||
        !planoId
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              'usuario_id e plano_id são obrigatórios.',
          });
      }

      const [
        usuarioExiste,
        plano,
      ] =
        await Promise.all([
          verificarUsuarioExiste(
            usuarioId
          ),

          buscarPlanoGooglePorId(
            planoId
          ),
        ]);

      if (!usuarioExiste) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              'usuario_id não encontrado em tab_usuarios.',
          });
      }

      if (!plano) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              'plano_id não encontrado em tab_planos.',
          });
      }

      const teste =
        await testarGravacaoAssinaturaGoogle({
          usuarioId,
          planoId,
        });

      return res.json({
        success:
          true,

        gravacao:
          teste,

        message:
          'Teste de gravação concluído e registro temporário removido.',
      });

    } catch (error) {
      console.error(
        '>>> ERRO NO TESTE DE GRAVAÇÃO:',
        error.response?.data ||
        error.message
      );

      return res
        .status(
          error.response?.status ||
          500
        )
        .json({
          success:
            false,

          error:
            error.response?.data?.error?.message ||
            error.response?.data?.message ||
            error.message,
        });
    }
  }
);

// ============================================================
// ROTA DE SAÚDE
// ============================================================

app.get(
  '/',
  (req, res) => {
    res.json({
      success:
        true,

      service:
        'Ache Obra - Google Play Backend',

      google_package_name_configurado:
        Boolean(
          process.env.GOOGLE_PACKAGE_NAME
        ),

      google_service_account_configurada:
        Boolean(
          process.env.GOOGLE_SERVICE_ACCOUNT_JSON
        ),

      supabase_configurado:
        Boolean(
          process.env.SUPABASE_URL &&
          process.env.SUPABASE_SERVICE_ROLE_KEY
        ),
    });
  }
);

// ============================================================
// GOOGLE - VALIDAR COMPRA / ASSINATURA
// ============================================================
//
// POST /google/validar-compra
//
// Suporta:
// - avulso -> avulso
// - avulso -> recorrente
// - recorrente -> recorrente
// - recorrente -> avulso
//
// REGRA PRINCIPAL:
// o plano atual só é substituído depois que a NOVA compra foi confirmada
// diretamente na Google Play Developer API.
//
// O backend não confia em "pago=true" vindo do Flutter.
// ============================================================

app.post(
  '/google/validar-compra',

  async (req, res) => {
    const requestId = req.googleRequestId || 'sem-id';

    console.log('==========================================');
    console.log('>>> GOOGLE PLAY - VALIDAR COMPRA/TROCA');
    console.log('==========================================');

    try {
      // --------------------------------------------------------
      // 1. AUTENTICAÇÃO SUPABASE
      // --------------------------------------------------------
      const usuario = await obterUsuarioSupabaseDoBearer(req);

      if (!usuario?.id) {
        logGoogle('VALIDAR_NEGADO_SEM_AUTH', {
          request_id: requestId,
        });

        return res.status(401).json({
          success: false,
          validado: false,
          error: 'Usuário não autenticado.',
        });
      }

      const usuarioIdBody = String(
        req.body?.usuario_id || ''
      ).trim();

      if (
        usuarioIdBody &&
        usuarioIdBody !== usuario.id
      ) {
        logGoogle('VALIDAR_NEGADO_USUARIO_DIVERGENTE', {
          request_id: requestId,
          usuario_auth: usuario.id,
          usuario_body: usuarioIdBody,
        });

        return res.status(403).json({
          success: false,
          validado: false,
          error:
            'O usuario_id informado não corresponde ao usuário autenticado.',
        });
      }

      // --------------------------------------------------------
      // 2. BODY
      // --------------------------------------------------------
      const planoId = String(
        req.body?.plano_id || ''
      ).trim();

      const googleProductIdRecebido = String(
        req.body?.google_product_id || ''
      ).trim();

      const googleBasePlanIdRecebido = String(
        req.body?.google_base_plan_id || ''
      ).trim();

      const purchaseToken = String(
        req.body?.purchase_token || ''
      ).trim();

      const tipoCompraRecebido = String(
        req.body?.tipo_compra || ''
      )
        .trim()
        .toLowerCase();

      const recorrenteRecebido =
        req.body?.recorrente === true ||
        tipoCompraRecebido === 'recorrente';

      const tipoCompra =
        recorrenteRecebido ? 'recorrente' : 'avulso';

      const tipoTrocaRecebido = String(
        req.body?.tipo_troca || ''
      )
        .trim()
        .toLowerCase();

      const purchaseTokenAnterior = String(
        req.body?.purchase_token_anterior || ''
      ).trim();

      const googleProductIdAnterior = String(
        req.body?.google_product_id_anterior || ''
      ).trim();

      const googleBasePlanIdAnterior = String(
        req.body?.google_base_plan_id_anterior || ''
      ).trim();

      if (!planoId || !purchaseToken) {
        return res.status(400).json({
          success: false,
          validado: false,
          error: 'plano_id e purchase_token são obrigatórios.',
        });
      }

      const tiposTrocaPermitidos = new Set([
        'avulso_para_avulso',
        'avulso_para_recorrente',
        'recorrente_para_recorrente',
        'recorrente_para_avulso',
      ]);

      const tipoTroca = tiposTrocaPermitidos.has(tipoTrocaRecebido)
        ? tipoTrocaRecebido
        : recorrenteRecebido
          ? 'avulso_para_recorrente'
          : 'avulso_para_avulso';

      logGoogle('VALIDAR_BODY_OK', {
        request_id: requestId,
        usuario_id: usuario.id,
        plano_id: planoId,
        google_product_id: googleProductIdRecebido,
        google_base_plan_id: googleBasePlanIdRecebido || null,
        purchase_token: purchaseToken,
        tipo_compra: tipoCompra,
        tipo_troca: tipoTroca,
        purchase_token_anterior: purchaseTokenAnterior || null,
        google_product_id_anterior: googleProductIdAnterior || null,
        google_base_plan_id_anterior: googleBasePlanIdAnterior || null,
      });

      // Selo: fluxo independente, sem trocar plano ou cancelar assinatura.
      if (googleProductIdRecebido === GOOGLE_SELO_PRODUCT_ID) {
        if (recorrenteRecebido) {
          return res.status(400).json({ success: false, validado: false, error: 'Selo de verificação é uma compra avulsa.' });
        }
        return await validarPagamentoSeloGoogle({
          req, res, usuario, planoId, purchaseToken, googleProductIdRecebido,
        });
      }

      // --------------------------------------------------------
      // 3. PLANO NO SUPABASE
      // --------------------------------------------------------
      const plano = await buscarPlanoGooglePorId(planoId);

      if (!plano) {
        return res.status(404).json({
          success: false,
          validado: false,
          error: 'Plano não encontrado no Supabase.',
        });
      }

      if (plano.google_ativo !== true) {
        return res.status(409).json({
          success: false,
          validado: false,
          error:
            'O pagamento Google ainda não está ativo para este plano.',
        });
      }

      const googleProductIdRecorrente = String(
        plano.google_product_id || ''
      ).trim();

      const googleProductIdAvulso = String(
        plano.google_product_id_avulso || ''
      ).trim();

      const googleProductIdEsperado =
        tipoCompra === 'recorrente'
          ? googleProductIdRecorrente
          : googleProductIdAvulso;

      const googleBasePlanIdEsperado = String(
        plano.google_base_plan_id || ''
      ).trim();

      if (!googleProductIdEsperado) {
        return res.status(409).json({
          success: false,
          validado: false,
          error:
            tipoCompra === 'recorrente'
              ? 'O plano não possui google_product_id recorrente configurado.'
              : 'O plano não possui google_product_id_avulso configurado.',
        });
      }

      if (
        tipoCompra === 'recorrente' &&
        !googleBasePlanIdEsperado
      ) {
        return res.status(409).json({
          success: false,
          validado: false,
          error:
            'O plano recorrente não possui google_base_plan_id configurado.',
        });
      }

      if (
        googleProductIdRecebido &&
        googleProductIdRecebido !== googleProductIdEsperado
      ) {
        return res.status(409).json({
          success: false,
          validado: false,
          error:
            tipoCompra === 'recorrente'
              ? 'google_product_id recorrente enviado pelo app não corresponde ao plano do Supabase.'
              : 'google_product_id_avulso enviado pelo app não corresponde ao plano do Supabase.',
        });
      }

      if (
        tipoCompra === 'recorrente' &&
        googleBasePlanIdRecebido &&
        googleBasePlanIdRecebido !== googleBasePlanIdEsperado
      ) {
        return res.status(409).json({
          success: false,
          validado: false,
          error:
            'google_base_plan_id enviado pelo app não corresponde ao plano do Supabase.',
        });
      }

      logGoogle('PLANO_SUPABASE_VALIDADO', {
        request_id: requestId,
        plano_id: plano.id,
        nome_plano: plano.nome_plano,
        product_id: googleProductIdEsperado,
        base_plan_id:
          tipoCompra === 'recorrente'
            ? googleBasePlanIdEsperado
            : null,
        tipo_compra: tipoCompra,
      });

      // --------------------------------------------------------
      // 4. IDEMPOTÊNCIA / PROPRIEDADE DO TOKEN
      // --------------------------------------------------------
      const registroExistente =
        await buscarAssinaturaGooglePorToken(purchaseToken);

      if (
        registroExistente &&
        String(registroExistente.usuario_id || '') !== String(usuario.id)
      ) {
        logGoogle('TOKEN_JA_PERTENCE_OUTRO_USUARIO', {
          request_id: requestId,
          purchase_token: purchaseToken,
          usuario_solicitante: usuario.id,
          usuario_registrado: registroExistente.usuario_id,
        });

        return res.status(409).json({
          success: false,
          validado: false,
          error:
            'Este purchase_token já está associado a outro usuário.',
        });
      }

      // ========================================================
      // 5A. COMPRA RECORRENTE
      // ========================================================
      if (tipoCompra === 'recorrente') {
        logGoogle('RECORRENTE_CONSULTA_INICIO', {
          request_id: requestId,
          purchase_token: purchaseToken,
        });

        const assinaturaGoogle =
          await consultarAssinaturaGoogle(purchaseToken);

        const subscriptionState = String(
          assinaturaGoogle?.subscriptionState || ''
        ).trim();

        const acknowledgementState = String(
          assinaturaGoogle?.acknowledgementState || ''
        ).trim();

        const lineItem = localizarLineItemDoProduto(
          assinaturaGoogle,
          googleProductIdEsperado
        );

        if (!lineItem) {
          return res.status(409).json({
            success: false,
            validado: false,
            error:
              'O purchase_token é válido, mas não pertence ao produto recorrente deste plano.',
          });
        }

        const productIdGoogle = String(
          lineItem.productId || ''
        ).trim();

        const basePlanIdGoogle =
          extrairBasePlanId(lineItem);

        if (productIdGoogle !== googleProductIdEsperado) {
          return res.status(409).json({
            success: false,
            validado: false,
            error:
              'Produto retornado pelo Google não corresponde ao produto configurado no Supabase.',
          });
        }

        if (
          basePlanIdGoogle &&
          basePlanIdGoogle !== googleBasePlanIdEsperado
        ) {
          return res.status(409).json({
            success: false,
            validado: false,
            error:
              'Base plan retornado pelo Google não corresponde ao plano configurado no Supabase.',
          });
        }

        if (!basePlanIdGoogle) {
          console.warn(
            '>>> Google não retornou basePlanId em offerDetails para este lineItem.'
          );
        }

        const expiryTime = lineItem.expiryTime || null;
        const startTime = assinaturaGoogle?.startTime || null;
        const orderId = extrairOrderId(lineItem);
        const autoRenovacao = extrairAutoRenovacao(lineItem);
        const linkedPurchaseToken =
          extrairLinkedPurchaseToken(assinaturaGoogle);

        const {
          statusInterno,
          assinaturaAtiva,
        } = mapearStatusGoogleParaInterno(
          subscriptionState,
          expiryTime
        );

        const agoraIso = new Date().toISOString();

        logGoogle('RECORRENTE_GOOGLE_RESPOSTA', {
          request_id: requestId,
          purchase_token: purchaseToken,
          subscription_state: subscriptionState,
          acknowledgement_state: acknowledgementState,
          product_id: productIdGoogle,
          base_plan_id: basePlanIdGoogle || null,
          order_id: orderId,
          expiry_time: expiryTime,
          auto_renovacao: autoRenovacao,
          linked_purchase_token: linkedPurchaseToken,
          assinatura_ativa: assinaturaAtiva,
          status_interno: statusInterno,
          test_purchase: Boolean(assinaturaGoogle?.testPurchase),
        });

        const registro =
          await inserirOuAtualizarAssinaturaGoogle({
            usuario_id: usuario.id,
            plano_id: plano.id,
            google_product_id: googleProductIdEsperado,
            google_base_plan_id: googleBasePlanIdEsperado,
            tipo_compra: 'recorrente',
            recorrente: true,
            purchase_token: purchaseToken,
            google_order_id: orderId,
            status_assinatura: statusInterno,
            acknowledgement_state:
              acknowledgementState || null,
            auto_renovacao: autoRenovacao,
            data_inicio: startTime || null,
            data_expiracao: expiryTime || null,
            data_ultimo_pagamento:
              assinaturaAtiva ? agoraIso : null,
            cancelado_em:
              subscriptionState === 'SUBSCRIPTION_STATE_CANCELED'
                ? agoraIso
                : null,
            updated_at: agoraIso,
          });

        if (!assinaturaAtiva) {
          logGoogle('RECORRENTE_NAO_LIBERADA', {
            request_id: requestId,
            status_google: subscriptionState,
            status_interno: statusInterno,
          });

          return res.status(202).json({
            success: true,
            validado: false,
            purchase_valid: false,
            assinatura_ativa: false,
            processando:
              statusInterno === 'pagamento_pendente',
            status_google: subscriptionState,
            status: statusInterno,
            acknowledgement_state:
              acknowledgementState || null,
            data_expiracao: expiryTime,
            assinatura: registro,
            message:
              'A assinatura foi localizada no Google, mas ainda não está em estado que libere o novo plano. O plano atual foi preservado.',
          });
        }

        // ------------------------------------------------------
        // RECORRENTE -> RECORRENTE
        // ------------------------------------------------------
        if (tipoTroca === 'recorrente_para_recorrente') {
          const anterior =
            await buscarAssinaturaGoogleAnteriorSegura({
              usuarioId: usuario.id,
              purchaseTokenAnterior,
            });

          logGoogle('TROCA_REC_REC_VALIDADA', {
            request_id: requestId,
            token_novo: purchaseToken,
            token_anterior: purchaseTokenAnterior || null,
            linked_purchase_token: linkedPurchaseToken,
            registro_anterior_encontrado: Boolean(anterior),
          });

          // O Billing Flow do Google faz a substituição. linkedPurchaseToken
          // é a evidência server-side da relação quando o Google o fornece.
          if (
            purchaseTokenAnterior &&
            linkedPurchaseToken &&
            linkedPurchaseToken !== purchaseTokenAnterior
          ) {
            logGoogle('TROCA_REC_REC_LINK_DIVERGENTE', {
              request_id: requestId,
              token_anterior: purchaseTokenAnterior,
              linked_purchase_token: linkedPurchaseToken,
            });

            return res.status(409).json({
              success: false,
              validado: false,
              error:
                'O Google confirmou a nova assinatura, mas o linkedPurchaseToken não corresponde à assinatura anterior informada.',
            });
          }

          if (
            purchaseTokenAnterior &&
            purchaseTokenAnterior !== purchaseToken
          ) {
            await marcarAssinaturaAnteriorComoSubstituida({
              purchaseTokenAnterior,
              motivo: 'substituido',
            });

            logGoogle('TROCA_REC_REC_ANTERIOR_MARCADA', {
              request_id: requestId,
              purchase_token_anterior: purchaseTokenAnterior,
            });
          }
        }

        // ------------------------------------------------------
        // AVULSO -> RECORRENTE ou RECORRENTE -> RECORRENTE
        // Só agora sincroniza o plano ativo.
        // ------------------------------------------------------
        const usuarioAtualizado =
          await atualizarPlanoAtivoUsuarioGoogle({
            usuarioId: usuario.id,
            plano,
            recorrente: true,
            dataAtivacao: startTime || agoraIso,
          });

        logGoogle('RECORRENTE_LIBERADA', {
          request_id: requestId,
          usuario_id: usuario.id,
          plano_id: plano.id,
          tipo_troca: tipoTroca,
        });

        return res.json({
          success: true,
          validado: true,
          purchase_valid: true,
          assinatura_ativa: true,
          plano_ativo: true,
          pago: true,
          recorrente: true,
          tipo_troca: tipoTroca,
          status_google: subscriptionState,
          status: statusInterno,
          acknowledgement_state:
            acknowledgementState || null,
          google_product_id: googleProductIdEsperado,
          google_base_plan_id: googleBasePlanIdEsperado,
          google_order_id: orderId,
          linked_purchase_token: linkedPurchaseToken,
          data_inicio: startTime,
          data_expiracao: expiryTime,
          auto_renovacao: autoRenovacao,
          test_purchase:
            assinaturaGoogle?.testPurchase ? true : false,
          assinatura: registro,
          usuario_plano: usuarioAtualizado,
        });
      }

      // ========================================================
      // 5B. COMPRA AVULSA / ONE-TIME PRODUCT
      // ========================================================
      logGoogle('AVULSO_CONSULTA_INICIO', {
        request_id: requestId,
        purchase_token: purchaseToken,
      });

      const compraGoogle =
        await consultarProdutoAvulsoGoogle(purchaseToken);

      const item = localizarLineItemProdutoAvulso(
        compraGoogle,
        googleProductIdEsperado
      );

      if (!item) {
        return res.status(409).json({
          success: false,
          validado: false,
          error:
            'O purchase_token é válido, mas não pertence ao produto avulso deste plano.',
        });
      }

      const productIdGoogle = String(
        item.productId || ''
      ).trim();

      if (productIdGoogle !== googleProductIdEsperado) {
        return res.status(409).json({
          success: false,
          validado: false,
          error:
            'Produto avulso retornado pelo Google não corresponde ao plano do Supabase.',
        });
      }

      const {
        statusGoogle,
        statusInterno,
        pago,
        processando,
      } = mapearStatusAvulsoGoogle(compraGoogle);

      const acknowledgementState = String(
        compraGoogle?.acknowledgementState || ''
      ).trim();

      const orderId = compraGoogle?.orderId
        ? String(compraGoogle.orderId).trim()
        : null;

      const purchaseCompletionTime =
        compraGoogle?.purchaseCompletionTime || null;

      const consumptionState = String(
        item?.productOfferDetails?.consumptionState || ''
      ).trim();

      const agoraIso = new Date().toISOString();

      logGoogle('AVULSO_GOOGLE_RESPOSTA', {
        request_id: requestId,
        purchase_token: purchaseToken,
        purchase_state: statusGoogle,
        status_interno: statusInterno,
        product_id: productIdGoogle,
        order_id: orderId,
        acknowledgement_state: acknowledgementState,
        consumption_state: consumptionState,
        purchase_completion_time: purchaseCompletionTime,
        test_purchase: Boolean(compraGoogle?.testPurchaseContext),
      });

      // Reutilizamos tab_assinaturas_google como histórico Google.
      // Para avulso, base plan é NULL, auto_renovacao=false e não há expiry.
      const registro =
        await inserirOuAtualizarAssinaturaGoogle({
          usuario_id: usuario.id,
          plano_id: plano.id,
          google_product_id: googleProductIdEsperado,
          google_base_plan_id: null,
          tipo_compra: 'avulso',
          recorrente: false,
          purchase_token: purchaseToken,
          google_order_id: orderId,
          status_assinatura: statusInterno,
          acknowledgement_state:
            acknowledgementState || null,
          auto_renovacao: false,
          data_inicio:
            purchaseCompletionTime || agoraIso,
          data_expiracao: null,
          data_ultimo_pagamento:
            pago
              ? purchaseCompletionTime || agoraIso
              : null,
          cancelado_em:
            statusGoogle === 'CANCELLED'
              ? agoraIso
              : null,
          updated_at: agoraIso,
        });

      if (!pago) {
        logGoogle('AVULSO_NAO_LIBERADO', {
          request_id: requestId,
          status_google: statusGoogle,
          status_interno: statusInterno,
          processando,
        });

        return res.status(processando ? 202 : 409).json({
          success: processando,
          validado: false,
          purchase_valid: false,
          assinatura_ativa: false,
          plano_ativo: false,
          pago: false,
          processando,
          status_google: statusGoogle,
          status: statusInterno,
          compra: registro,
          message: processando
            ? 'Pagamento avulso pendente no Google. O plano atual foi preservado.'
            : 'A compra avulsa não está paga e o plano não foi alterado.',
        });
      }

      // --------------------------------------------------------
      // RECORRENTE -> AVULSO
      // Nova compra já está PAGA. Somente agora cancelamos a próxima
      // renovação da assinatura antiga.
      // --------------------------------------------------------
      let assinaturaAnteriorCancelada = false;

      if (tipoTroca === 'recorrente_para_avulso') {
        if (!purchaseTokenAnterior) {
          logGoogle('REC_AVULSO_SEM_TOKEN_ANTERIOR', {
            request_id: requestId,
            usuario_id: usuario.id,
          });

          return res.status(409).json({
            success: false,
            validado: false,
            purchase_valid: true,
            pagamento_confirmado: true,
            pago: true,
            troca_plano: false,
            status: 'pagamento_confirmado_aguardando_troca',
            error:
              'O pagamento avulso foi confirmado, mas não foi possível identificar com segurança a assinatura recorrente anterior. Não compre novamente; a troca deve ser retomada.',
          });
        }

        const anterior =
          await buscarAssinaturaGoogleAnteriorSegura({
            usuarioId: usuario.id,
            purchaseTokenAnterior,
          });

        if (!anterior) {
          return res.status(409).json({
            success: false,
            validado: false,
            purchase_valid: true,
            pagamento_confirmado: true,
            pago: true,
            troca_plano: false,
            status: 'pagamento_confirmado_aguardando_troca',
            error:
              'O pagamento avulso foi confirmado, mas a assinatura anterior não foi encontrada no histórico local. Não compre novamente.',
          });
        }

        try {
          await cancelarRenovacaoAssinaturaGoogleV2(
            purchaseTokenAnterior
          );

          assinaturaAnteriorCancelada = true;

          await atualizarAssinaturaGooglePorToken(
            purchaseTokenAnterior,
            {
              status_assinatura: 'cancelado_com_acesso',
              tipo_compra: 'recorrente',
              recorrente: true,
              cancelado_em: agoraIso,
              auto_renovacao: false,
              updated_at: agoraIso,
            }
          );

          logGoogle('REC_AVULSO_ANTERIOR_CANCELADA', {
            request_id: requestId,
            purchase_token_anterior: purchaseTokenAnterior,
            plano_anterior: anterior.plano_id,
          });
        } catch (cancelError) {
          logGoogle('REC_AVULSO_ERRO_CANCELAMENTO', {
            request_id: requestId,
            purchase_token_anterior: purchaseTokenAnterior,
            http_status: cancelError.response?.status || null,
            erro:
              cancelError.response?.data?.error?.message ||
              cancelError.message,
          });

          return res.status(409).json({
            success: false,
            validado: false,
            purchase_valid: true,
            pagamento_confirmado: true,
            pago: true,
            troca_plano: false,
            status: 'pagamento_confirmado_aguardando_troca',
            error:
              'O novo pagamento avulso foi confirmado, mas o Google ainda não confirmou o cancelamento da renovação anterior. Não compre novamente.',
          });
        }
      }

      // --------------------------------------------------------
      // AVULSO -> AVULSO ou RECORRENTE -> AVULSO
      // Só chegamos aqui com pagamento confirmado.
      // --------------------------------------------------------
      const usuarioAtualizado =
        await atualizarPlanoAtivoUsuarioGoogle({
          usuarioId: usuario.id,
          plano,
          recorrente: false,
          dataAtivacao:
            purchaseCompletionTime || agoraIso,
        });

      logGoogle('AVULSO_LIBERADO', {
        request_id: requestId,
        usuario_id: usuario.id,
        plano_id: plano.id,
        tipo_troca: tipoTroca,
        assinatura_anterior_cancelada:
          assinaturaAnteriorCancelada,
      });

      return res.json({
        success: true,
        validado: true,
        purchase_valid: true,
        assinatura_ativa: false,
        plano_ativo: true,
        pagamento_confirmado: true,
        pago: true,
        troca_plano: true,
        recorrente: false,
        tipo_troca: tipoTroca,
        status_google: statusGoogle,
        status: statusInterno,
        google_product_id: googleProductIdEsperado,
        google_base_plan_id: null,
        google_order_id: orderId,
        acknowledgement_state:
          acknowledgementState || null,
        consumption_state:
          consumptionState || null,
        data_pagamento:
          purchaseCompletionTime || agoraIso,
        assinatura_anterior_cancelada:
          assinaturaAnteriorCancelada,
        test_purchase:
          compraGoogle?.testPurchaseContext ? true : false,
        compra: registro,
        usuario_plano: usuarioAtualizado,
      });

    } catch (error) {
      const statusHttp =
        error.response?.status || 500;

      let mensagem =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message ||
        'Erro desconhecido ao validar compra Google.';

      if (typeof mensagem !== 'string') {
        mensagem = JSON.stringify(mensagem);
      }

      logGoogle('VALIDAR_ERRO', {
        request_id: requestId,
        http_status: statusHttp,
        erro: mensagem,
        google_status: error.response?.status || null,
      });

      console.error(
        '>>> ERRO AO VALIDAR COMPRA GOOGLE:',
        error.response?.data || error.message
      );

      return res.status(statusHttp).json({
        success: false,
        validado: false,
        error: mensagem,
      });
    }
  }
);

// ============================================================
// GOOGLE - CANCELAR PLANO
// ============================================================
//
// POST /google/cancelar-plano
//
// - Recorrente: interrompe somente as próximas renovações no Google Play.
// - Avulso: solicita reembolso do pedido Google Play e revoga o item.
//
// Segurança:
// - exige sessão Supabase;
// - confirma que o purchase_token pertence ao usuário autenticado;
// - confirma plano/produto/tipo de compra pelo registro local;
// - para recorrente, confirma a assinatura diretamente no Google antes de cancelar;
// - para avulso, confirma a compra diretamente no Google antes do reembolso.
// ============================================================

async function reembolsarPedidoGoogle({ orderId, revoke = true }) {
  const pedido = String(orderId || '').trim();

  if (!pedido) {
    throw new Error('google_order_id não disponível para solicitar o reembolso.');
  }

  const packageName = obterGooglePackageName();
  const accessToken = await obterAccessTokenGoogle();

  logGoogle('GOOGLE_PEDIDO_REEMBOLSO_INICIO', {
    package_name: packageName,
    order_id: pedido,
    revoke: Boolean(revoke),
  });

  await axios({
    method: 'POST',
    url:
      `${GOOGLE_ANDROID_PUBLISHER_BASE_URL}` +
      `/applications/${encodeURIComponent(packageName)}` +
      `/orders/${encodeURIComponent(pedido)}:refund`,
    params: {
      revoke: Boolean(revoke),
    },
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    data: {},
    timeout: 30000,
  });

  logGoogle('GOOGLE_PEDIDO_REEMBOLSO_OK', {
    order_id: pedido,
    revoke: Boolean(revoke),
  });

  return true;
}

app.post(
  '/google/cancelar-plano',

  async (req, res) => {
    const requestId = req.googleRequestId || 'sem-id';

    try {
      const usuario = await obterUsuarioSupabaseDoBearer(req);

      if (!usuario?.id) {
        return res.status(401).json({
          success: false,
          error: 'Usuário não autenticado.',
        });
      }

      const planoId = String(req.body?.plano_id || '').trim();
      const purchaseToken = String(req.body?.purchase_token || '').trim();
      const googleProductIdRecebido = String(
        req.body?.google_product_id || ''
      ).trim();
      const googleBasePlanIdRecebido = String(
        req.body?.google_base_plan_id || ''
      ).trim();
      const tipoCompraRecebido = String(
        req.body?.tipo_compra || ''
      )
        .trim()
        .toLowerCase();
      const recorrenteRecebido =
        req.body?.recorrente === true ||
        tipoCompraRecebido === 'recorrente';
      const tipoCompra = recorrenteRecebido ? 'recorrente' : 'avulso';

      if (!planoId || !purchaseToken) {
        return res.status(400).json({
          success: false,
          error: 'plano_id e purchase_token são obrigatórios.',
        });
      }

      logGoogle('CANCELAR_PLANO_INICIO', {
        request_id: requestId,
        usuario_id: usuario.id,
        plano_id: planoId,
        purchase_token: purchaseToken,
        google_product_id: googleProductIdRecebido || null,
        google_base_plan_id: googleBasePlanIdRecebido || null,
        tipo_compra: tipoCompra,
      });

      const [plano, registroLocal] = await Promise.all([
        buscarPlanoGooglePorId(planoId),
        buscarAssinaturaGooglePorToken(purchaseToken),
      ]);

      if (!plano) {
        return res.status(404).json({
          success: false,
          error: 'Plano não encontrado no Supabase.',
        });
      }

      if (!registroLocal) {
        return res.status(404).json({
          success: false,
          error: 'Compra Google não encontrada no histórico do usuário.',
        });
      }

      if (String(registroLocal.usuario_id || '') !== String(usuario.id)) {
        return res.status(403).json({
          success: false,
          error: 'Esta compra Google não pertence ao usuário autenticado.',
        });
      }

      if (String(registroLocal.plano_id || '') !== planoId) {
        return res.status(409).json({
          success: false,
          error: 'O purchase_token não corresponde ao plano informado.',
        });
      }

      const tipoCompraLocal = String(
        registroLocal.tipo_compra || ''
      )
        .trim()
        .toLowerCase();

      const recorrenteLocal =
        registroLocal.recorrente === true ||
        tipoCompraLocal === 'recorrente' ||
        String(registroLocal.google_base_plan_id || '').trim().length > 0;

      const tipoCompraSeguro = recorrenteLocal ? 'recorrente' : 'avulso';

      if (tipoCompraSeguro !== tipoCompra) {
        return res.status(409).json({
          success: false,
          error: 'O tipo de compra informado não corresponde ao histórico Google.',
        });
      }

      const productIdLocal = String(
        registroLocal.google_product_id || ''
      ).trim();

      if (
        googleProductIdRecebido &&
        productIdLocal &&
        googleProductIdRecebido !== productIdLocal
      ) {
        return res.status(409).json({
          success: false,
          error: 'google_product_id não corresponde à compra registrada.',
        });
      }

      const agoraIso = new Date().toISOString();

      // ========================================================
      // ASSINATURA RECORRENTE
      // ========================================================
      if (tipoCompraSeguro === 'recorrente') {
        const assinaturaGoogle = await consultarAssinaturaGoogle(purchaseToken);
        const lineItem = localizarLineItemDoProduto(
          assinaturaGoogle,
          productIdLocal || googleProductIdRecebido
        );

        if (!lineItem) {
          return res.status(409).json({
            success: false,
            error:
              'A assinatura foi localizada no Google, mas não corresponde ao produto registrado.',
          });
        }

        const basePlanGoogle = extrairBasePlanId(lineItem);
        const basePlanLocal = String(
          registroLocal.google_base_plan_id || ''
        ).trim();

        if (
          googleBasePlanIdRecebido &&
          basePlanLocal &&
          googleBasePlanIdRecebido !== basePlanLocal
        ) {
          return res.status(409).json({
            success: false,
            error: 'google_base_plan_id não corresponde à assinatura registrada.',
          });
        }

        if (
          basePlanGoogle &&
          basePlanLocal &&
          basePlanGoogle !== basePlanLocal
        ) {
          return res.status(409).json({
            success: false,
            error: 'A base plan retornada pelo Google não corresponde ao histórico local.',
          });
        }

        const subscriptionState = String(
          assinaturaGoogle?.subscriptionState || ''
        ).trim();
        const autoRenovacao = extrairAutoRenovacao(lineItem);
        const expiryTime = lineItem?.expiryTime || registroLocal.data_expiracao || null;

        // Se já estiver cancelada para renovação, a operação é idempotente.
        if (
          subscriptionState !== 'SUBSCRIPTION_STATE_CANCELED' &&
          autoRenovacao !== false
        ) {
          await cancelarRenovacaoAssinaturaGoogleV2(purchaseToken);
        }

        const atualizado = await atualizarAssinaturaGooglePorToken(
          purchaseToken,
          {
            status_assinatura: 'cancelado_com_acesso',
            tipo_compra: 'recorrente',
            recorrente: true,
            auto_renovacao: false,
            cancelado_em: agoraIso,
            updated_at: agoraIso,
          }
        );

        // Regra comercial do Ache Obra: o cancelamento encerra os benefícios
        // pagos imediatamente, mesmo que a validade original ainda não tenha acabado.
        const downgrade = await retornarUsuarioAoPlanoGratisGoogle({
          usuarioId: usuario.id,
          planoAtual: plano,
        });

        logGoogle('CANCELAR_PLANO_RECORRENTE_OK', {
          request_id: requestId,
          usuario_id: usuario.id,
          plano_id: planoId,
          purchase_token: purchaseToken,
          expiry_time: expiryTime,
        });

        return res.json({
          success: true,
          status: 'cancelado',
          tipo_compra: 'recorrente',
          recorrente: true,
          renovacao_cancelada: true,
          acesso_pago_encerrado_imediatamente: true,
          plano_gratis: downgrade.planoGratis,
          data_expiracao: expiryTime,
          assinatura: atualizado,
          mensagem:
            'Renovação cancelada na Google Play. Seu acesso pago foi encerrado e o plano Grátis foi ativado imediatamente.',
        });
      }

      // ========================================================
      // COMPRA AVULSA
      // ========================================================
      const compraGoogle = await consultarProdutoAvulsoGoogle(purchaseToken);
      const item = localizarLineItemProdutoAvulso(
        compraGoogle,
        productIdLocal || googleProductIdRecebido
      );

      if (!item) {
        return res.status(409).json({
          success: false,
          error:
            'A compra foi localizada no Google, mas não corresponde ao produto avulso registrado.',
        });
      }

      const { statusGoogle, statusInterno, pago, processando } =
        mapearStatusAvulsoGoogle(compraGoogle);

      // A compra pode ter sido cancelada/reembolsada diretamente no Google
      // Play Console ou pela própria Play Store. Nesse caso, não tentamos
      // reembolsá-la novamente: sincronizamos o estado local e encerramos
      // os benefícios do plano pago. A resposta do Google é a fonte de
      // verdade; uma compra pendente/desconhecida nunca provoca downgrade.
      if (!pago && statusGoogle === 'CANCELLED') {
        const atualizado = await atualizarAssinaturaGooglePorToken(
          purchaseToken,
          {
            status_assinatura: 'estornado',
            tipo_compra: 'avulso',
            recorrente: false,
            auto_renovacao: false,
            cancelado_em: agoraIso,
            updated_at: agoraIso,
          }
        );

        const downgrade = await retornarUsuarioAoPlanoGratisGoogle({
          usuarioId: usuario.id,
          planoAtual: plano,
        });

        logGoogle('CANCELAR_PLANO_AVULSO_JA_CANCELADO_NO_GOOGLE', {
          request_id: requestId,
          usuario_id: usuario.id,
          plano_id: planoId,
          purchase_token: purchaseToken,
          status_google: statusGoogle,
        });

        return res.json({
          success: true,
          status: 'estornado',
          status_google: statusGoogle,
          tipo_compra: 'avulso',
          recorrente: false,
          reembolso_solicitado: false,
          compra_ja_cancelada_no_google: true,
          acesso_pago_encerrado_imediatamente: true,
          plano_gratis: downgrade.planoGratis,
          compra: atualizado,
          mensagem:
            'O Google Play já havia cancelado esta compra. O Ache Obra sincronizou o cancelamento e ativou o plano Grátis.',
        });
      }

      if (!pago) {
        return res.status(processando ? 202 : 409).json({
          success: false,
          status: statusInterno || statusGoogle,
          status_google: statusGoogle,
          processando: Boolean(processando),
          error: processando
            ? 'O pagamento ainda está pendente no Google Play. O plano não pode ser cancelado como compra paga até a confirmação do estado final.'
            : 'O Google Play não confirmou esta compra como paga nem como cancelada. O plano não foi alterado; tente sincronizar novamente.',
        });
      }

      const orderId = String(
        registroLocal.google_order_id || compraGoogle?.orderId || ''
      ).trim();

      if (!orderId) {
        return res.status(409).json({
          success: false,
          error:
            'O pedido Google desta compra não possui google_order_id para solicitar reembolso.',
        });
      }

      try {
        await reembolsarPedidoGoogle({
          orderId,
          revoke: true,
        });
      } catch (refundError) {
        const googleStatus = refundError.response?.status || null;
        const googleMensagem =
          refundError.response?.data?.error?.message ||
          refundError.response?.data?.message ||
          refundError.message ||
          'Erro ao solicitar reembolso no Google Play.';

        logGoogle('CANCELAR_PLANO_AVULSO_REEMBOLSO_ERRO', {
          request_id: requestId,
          usuario_id: usuario.id,
          plano_id: planoId,
          order_id: orderId,
          http_status: googleStatus,
          erro: googleMensagem,
        });

        return res.status(googleStatus || 409).json({
          success: false,
          status: 'reembolso_nao_confirmado',
          error:
            'O Google Play não confirmou o reembolso deste pedido. O plano não foi cancelado no Ache Obra.',
          detalhe_google: googleMensagem,
        });
      }

      const atualizado = await atualizarAssinaturaGooglePorToken(
        purchaseToken,
        {
          status_assinatura: 'estornado',
          tipo_compra: 'avulso',
          recorrente: false,
          auto_renovacao: false,
          cancelado_em: agoraIso,
          updated_at: agoraIso,
        }
      );

      const downgrade = await retornarUsuarioAoPlanoGratisGoogle({
        usuarioId: usuario.id,
        planoAtual: plano,
      });

      logGoogle('CANCELAR_PLANO_AVULSO_OK', {
        request_id: requestId,
        usuario_id: usuario.id,
        plano_id: planoId,
        purchase_token: purchaseToken,
        order_id: orderId,
      });

      return res.json({
        success: true,
        status: 'estornado',
        tipo_compra: 'avulso',
        recorrente: false,
        reembolso_solicitado: true,
        acesso_pago_encerrado_imediatamente: true,
        plano_gratis: downgrade.planoGratis,
        google_order_id: orderId,
        compra: atualizado,
        mensagem:
          'Reembolso solicitado à Google Play. O plano Grátis foi ativado imediatamente.',
      });
    } catch (error) {
      const statusHttp = error.response?.status || 500;
      let mensagem =
        error.response?.data?.error?.message ||
        error.response?.data?.message ||
        error.message ||
        'Erro desconhecido ao cancelar plano Google.';

      if (typeof mensagem !== 'string') {
        mensagem = JSON.stringify(mensagem);
      }

      logGoogle('CANCELAR_PLANO_ERRO', {
        request_id: requestId,
        http_status: statusHttp,
        erro: mensagem,
      });

      return res.status(statusHttp).json({
        success: false,
        error: mensagem,
      });
    }
  }
);


// ============================================================
// GOOGLE - CONSULTAR STATUS JÁ REGISTRADO
// ============================================================
//
// GET /google/status/:purchaseToken
//
// Útil depois para restaurar/sincronizar a compra.
// Requer sessão Supabase.
// ============================================================

app.get(
  '/google/status/:purchaseToken',

  async (req, res) => {
    try {
      const usuario =
        await obterUsuarioSupabaseDoBearer(
          req
        );

      if (!usuario?.id) {
        return res
          .status(401)
          .json({
            success:
              false,

            error:
              'Usuário não autenticado.',
          });
      }

      const purchaseToken =
        String(
          req.params?.purchaseToken ||
          ''
        ).trim();

      if (!purchaseToken) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              'purchaseToken é obrigatório.',
          });
      }

      const registroLocal =
        await buscarAssinaturaGooglePorToken(
          purchaseToken
        );

      if (
        !registroLocal ||
        registroLocal.usuario_id !==
          usuario.id
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              'Assinatura Google não encontrada para este usuário.',
          });
      }

      const assinaturaGoogle =
        await consultarAssinaturaGoogle(
          purchaseToken
        );

      return res.json({
        success:
          true,

        local:
          registroLocal,

        google:
          assinaturaGoogle,
      });

    } catch (error) {
      console.error(
        '>>> ERRO AO CONSULTAR STATUS GOOGLE:',
        error.response?.data ||
        error.message
      );

      return res
        .status(
          error.response?.status ||
          500
        )
        .json({
          success:
            false,

          error:
            error.response?.data?.error?.message ||
            error.message,
        });
    }
  }
);

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      '=========================================='
    );

    console.log(
      '>>> Ache Obra - Google Play Backend'
    );

    console.log(
      `>>> Porta: ${PORT}`
    );

    console.log(
      `>>> Package configurado: ${
        process.env.GOOGLE_PACKAGE_NAME
          ? 'SIM'
          : 'NÃO'
      }`
    );

    console.log(
      `>>> Service Account configurada: ${
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON
          ? 'SIM'
          : 'NÃO'
      }`
    );

    console.log(
      `>>> Supabase configurado: ${
        process.env.SUPABASE_URL &&
        process.env.SUPABASE_SERVICE_ROLE_KEY
          ? 'SIM'
          : 'NÃO'
      }`
    );

    console.log(
      '=========================================='
    );
  }
);