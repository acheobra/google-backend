const express = require('express');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

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
          'id,nome_plano,google_product_id,google_base_plan_id,google_ativo',

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
// Authorization:
// Bearer <access_token Supabase>
//
// Body esperado do checkout_google.dart:
//
// {
//   "usuario_id": "...",
//   "plano_id": "...",
//   "google_product_id": "...",
//   "google_base_plan_id": "...",
//   "purchase_token": "...",
//   "purchase_id": "...",
//   "transaction_date": "...",
//   "verification_source": "..."
// }
//
// IMPORTANTE:
// O backend NÃO confia nos IDs enviados pelo Flutter.
// Ele confere:
// - usuário autenticado
// - plano do Supabase
// - productId retornado pelo Google
// - basePlanId retornado pelo Google
// ============================================================

app.post(
  '/google/validar-compra',

  async (req, res) => {
    console.log(
      '=========================================='
    );

    console.log(
      '>>> GOOGLE PLAY - VALIDAR COMPRA'
    );

    console.log(
      '=========================================='
    );

    try {
      // --------------------------------------------------------
      // USUÁRIO
      // --------------------------------------------------------

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

            validado:
              false,

            error:
              'Usuário não autenticado.',
          });
      }

      const usuarioIdBody =
        String(
          req.body?.usuario_id ||
          ''
        ).trim();

      if (
        usuarioIdBody &&
        usuarioIdBody !== usuario.id
      ) {
        return res
          .status(403)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'O usuario_id informado não corresponde ao usuário autenticado.',
          });
      }

      // --------------------------------------------------------
      // BODY
      // --------------------------------------------------------

      const planoId =
        String(
          req.body?.plano_id ||
          ''
        ).trim();

      const googleProductIdRecebido =
        String(
          req.body?.google_product_id ||
          ''
        ).trim();

      const googleBasePlanIdRecebido =
        String(
          req.body?.google_base_plan_id ||
          ''
        ).trim();

      const purchaseToken =
        String(
          req.body?.purchase_token ||
          ''
        ).trim();

      if (
        !planoId ||
        !purchaseToken
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'plano_id e purchase_token são obrigatórios.',
          });
      }

      // --------------------------------------------------------
      // PLANO NO SUPABASE
      // --------------------------------------------------------

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

            validado:
              false,

            error:
              'Plano não encontrado no Supabase.',
          });
      }

      if (
        plano.google_ativo !== true
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'O pagamento Google ainda não está ativo para este plano.',
          });
      }

      const googleProductIdEsperado =
        String(
          plano.google_product_id ||
          ''
        ).trim();

      const googleBasePlanIdEsperado =
        String(
          plano.google_base_plan_id ||
          ''
        ).trim();

      if (
        !googleProductIdEsperado ||
        !googleBasePlanIdEsperado
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'O plano não possui google_product_id/google_base_plan_id configurados.',
          });
      }

      if (
        googleProductIdRecebido &&
        googleProductIdRecebido !==
          googleProductIdEsperado
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'google_product_id enviado pelo app não corresponde ao plano do Supabase.',
          });
      }

      if (
        googleBasePlanIdRecebido &&
        googleBasePlanIdRecebido !==
          googleBasePlanIdEsperado
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'google_base_plan_id enviado pelo app não corresponde ao plano do Supabase.',
          });
      }

      // --------------------------------------------------------
      // CONSULTA DIRETA AO GOOGLE
      // --------------------------------------------------------

      const assinaturaGoogle =
        await consultarAssinaturaGoogle(
          purchaseToken
        );

      const subscriptionState =
        String(
          assinaturaGoogle
            ?.subscriptionState ||
          ''
        ).trim();

      const acknowledgementState =
        String(
          assinaturaGoogle
            ?.acknowledgementState ||
          ''
        ).trim();

      const lineItem =
        localizarLineItemDoProduto(
          assinaturaGoogle,
          googleProductIdEsperado
        );

      if (!lineItem) {
        return res
          .status(409)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'O purchase_token é válido, mas não pertence ao produto Google deste plano.',
          });
      }

      const productIdGoogle =
        String(
          lineItem.productId ||
          ''
        ).trim();

      const basePlanIdGoogle =
        extrairBasePlanId(
          lineItem
        );

      if (
        productIdGoogle !==
        googleProductIdEsperado
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'Produto retornado pelo Google não corresponde ao produto configurado no Supabase.',
          });
      }

      if (
        basePlanIdGoogle &&
        basePlanIdGoogle !==
          googleBasePlanIdEsperado
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            validado:
              false,

            error:
              'Base plan retornado pelo Google não corresponde ao plano configurado no Supabase.',
          });
      }

      //
      // Se por alguma razão a API não devolver offerDetails,
      // não bloqueamos somente por ausência; o productId ainda
      // precisa obrigatoriamente ser o correto.
      //
      if (!basePlanIdGoogle) {
        console.warn(
          '>>> Google não retornou basePlanId em offerDetails para este lineItem.'
        );
      }

      const expiryTime =
        lineItem.expiryTime ||
        null;

      const startTime =
        assinaturaGoogle
          ?.startTime ||
        null;

      const orderId =
        extrairOrderId(
          lineItem
        );

      const autoRenovacao =
        extrairAutoRenovacao(
          lineItem
        );

      const {
        statusInterno,
        assinaturaAtiva,
      } =
        mapearStatusGoogleParaInterno(
          subscriptionState,
          expiryTime
        );

      // --------------------------------------------------------
      // REGISTRA / ATUALIZA NO SUPABASE
      // --------------------------------------------------------

      const agoraIso =
        new Date()
          .toISOString();

      const registro =
        await inserirOuAtualizarAssinaturaGoogle({
          usuario_id:
            usuario.id,

          plano_id:
            plano.id,

          google_product_id:
            googleProductIdEsperado,

          google_base_plan_id:
            googleBasePlanIdEsperado,

          purchase_token:
            purchaseToken,

          google_order_id:
            orderId,

          status_assinatura:
            statusInterno,

          acknowledgement_state:
            acknowledgementState ||
            null,

          auto_renovacao:
            autoRenovacao,

          data_inicio:
            startTime ||
            null,

          data_expiracao:
            expiryTime ||
            null,

          data_ultimo_pagamento:
            assinaturaAtiva
              ? agoraIso
              : null,

          cancelado_em:
            subscriptionState ===
              'SUBSCRIPTION_STATE_CANCELED'
                ? agoraIso
                : null,

          updated_at:
            agoraIso,
        });

      console.log(
        '>>> Google Play validado.',
        '| usuario:',
        usuario.id,
        '| plano:',
        plano.id,
        '| produto:',
        googleProductIdEsperado,
        '| status:',
        subscriptionState,
        '| interno:',
        statusInterno,
        '| ativo:',
        assinaturaAtiva
      );

      // --------------------------------------------------------
      // RESPOSTA PARA O FLUTTER
      // --------------------------------------------------------
      //
      // O checkout_google.dart espera:
      // success=true
      // e pelo menos um:
      // validado=true
      // purchase_valid=true
      // assinatura_ativa=true
      //
      // Só devolvemos validado=true quando há direito de acesso.
      // --------------------------------------------------------

      if (!assinaturaAtiva) {
        return res
          .status(202)
          .json({
            success:
              true,

            validado:
              false,

            purchase_valid:
              false,

            assinatura_ativa:
              false,

            status_google:
              subscriptionState,

            status:
              statusInterno,

            acknowledgement_state:
              acknowledgementState ||
              null,

            data_expiracao:
              expiryTime,

            assinatura:
              registro,

            message:
              'A compra foi localizada no Google, mas a assinatura ainda não está em um estado que libere acesso.',
          });
      }

      return res.json({
        success:
          true,

        validado:
          true,

        purchase_valid:
          true,

        assinatura_ativa:
          true,

        status_google:
          subscriptionState,

        status:
          statusInterno,

        acknowledgement_state:
          acknowledgementState ||
          null,

        google_product_id:
          googleProductIdEsperado,

        google_base_plan_id:
          googleBasePlanIdEsperado,

        google_order_id:
          orderId,

        data_inicio:
          startTime,

        data_expiracao:
          expiryTime,

        auto_renovacao:
          autoRenovacao,

        test_purchase:
          assinaturaGoogle
            ?.testPurchase
            ? true
            : false,

        assinatura:
          registro,
      });

    } catch (error) {
      console.error(
        '>>> ERRO AO VALIDAR COMPRA GOOGLE:',
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
        'Erro desconhecido ao validar compra Google.';

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

          validado:
            false,

          error:
            mensagem,
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
