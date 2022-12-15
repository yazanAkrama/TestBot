"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const telegraf_1 = require("telegraf");
const telegraf_throttler_1 = require("telegraf-throttler");
const config_1 = __importDefault(require("./config"));
const uuid_1 = require("uuid");
const axios_1 = __importDefault(require("axios"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const cluster_1 = __importDefault(require("cluster"));
const socks_proxy_agent_1 = require("socks-proxy-agent");
const https_proxy_agent_1 = require("https-proxy-agent");
const md5_1 = __importDefault(require("md5"));
// "start": "npm install && node ./index.js",
let httpsAgent = undefined;
if (config_1.default.httpsProxy) {
    httpsAgent = new https_proxy_agent_1.HttpsProxyAgent(config_1.default.httpsProxy);
    console.log('HttpsProxyAgent ' + config_1.default.httpsProxy);
    httpsAgent.timeout = 3000;
}
else if (config_1.default.socksProxy) {
    httpsAgent = new socks_proxy_agent_1.SocksProxyAgent(config_1.default.socksProxy);
    console.log('SocksProxyAgent ' + config_1.default.socksProxy);
    httpsAgent.timeout = 30000;
}
const signV1 = (obj) => {
    const str = JSON.stringify(obj);
    return (0, md5_1.default)('https://h5.tu.qq.com' +
        (str.length + (encodeURIComponent(str).match(/%[89ABab]/g)?.length || 0)) +
        'HQ31X02e');
};
const qqRequest = async (imgData) => {
    const uuid = (0, uuid_1.v4)();
    let response;
    let data;
    for (let retry = 0; retry < 1; retry++) {
        const obj = {
            busiId: 'ai_painting_anime_entry',
            extra: JSON.stringify({
                face_rects: [],
                version: 2,
                platform: 'web',
                data_report: {
                    parent_trace_id: uuid,
                    root_channel: '',
                    level: 0,
                },
            }),
            images: [imgData],
        };
        try {
            response = await axios_1.default.request({
                httpsAgent,
                method: 'POST',
                url: 'https://ai.tu.qq.com/trpc.shadow_cv.ai_processor_cgi.AIProcessorCgi/Process',
                data: obj,
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://h5.tu.qq.com',
                    'Referer': 'https://h5.tu.qq.com/',
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
                    'x-sign-value': signV1(obj),
                    'x-sign-version': 'v1',
                },
                timeout: 300,
            });
        }
        catch (e) {
            response = e.response;
        }
        data = response?.data;
        if (data?.msg === 'IMG_ILLEGAL') {
            throw new Error('Couldn\'t pass the censorship. Try another photo.');
        }
        if (data?.msg === 'VOLUMN_LIMIT') {
            retry--;
            console.log('QQ rate limit caught');
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        if (data?.code === 1001) {
            throw new Error('Face not found. Try another photo.');
        }
        if (data?.code === -2100) { // request image is invalid
            throw new Error('Try another photo.');
        }
        if (data?.code === 2119 || // user_ip_country
            data?.code === -2111 // AUTH_FAILED
        ) {
            console.error('Blocked', data);
            throw new Error(config_1.default.blockedMessage || 'The Chinese website has blocked the bot, too bad 🤷‍♂️');
        }
        if (data?.extra) {
            break;
        }
        console.error('Got no data from QQ', data);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (data?.extra) {
        const extra = JSON.parse(data.extra);
        return {
            video: extra.video_urls[0],
            img: extra.img_urls[1],
        };
    }
    else {
        throw new Error(JSON.stringify(response?.data));
    }
};
const qqDownload = async (url) => {
    let response;
    for (let retry = 0; retry < 100; retry++) {
        try {
            response = await axios_1.default.request({
                httpsAgent,
                url,
                timeout: 50000,
                responseType: 'arraybuffer',
            });
        }
        catch (e) {
            response = e.response;
            console.error('QQ file download error caught: ' + e.toString());
        }
        if (response?.data) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return response?.data;
};
const userSessions = [];
const cropImage = async (imgData) => {
    const img = await (0, sharp_1.default)(imgData);
    const meta = await img.metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    let cropHeight;
    if (width > height) {
        cropHeight = 177;
    }
    else {
        cropHeight = 182;
    }
    return img.extract({
        top: 0,
        left: 0,
        width,
        height: height - cropHeight,
    })
        .toBuffer();
};
const processUserSession = async ({ ctx, userId, photoId, replyMessageId }) => {
    try {
        const url = await ctx.telegram.getFileLink(photoId);
        let response;
        for (let retry = 0; retry < 100; retry++) {
            try {
                response = await axios_1.default.request({
                    url: url.href,
                    timeout: 50000,
                    responseType: 'arraybuffer',
                });
            }
            catch (e) {
                console.error('Telegram file download error caught: ' + e.toString());
            }
            if (response?.data) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!response) {
            console.log('Couldn\'t load the photo from ' + userId);
            throw new Error('Couldn\'t load the photo, please try again');
        }
        if (config_1.default.keepFiles) {
            try {
                console.log("response datayzazazn", response.data, 'test', process.cwd());
                promises_1.default.writeFile(path_1.default.join(__dirname, 'files', (new Date()).getTime() + '_' + userId + '_input.jpg'), response.data);
            }
            catch (e) {
                console.log('error is' + e);
            }
        }
        try {
            await ctx.reply('Photo has been received, please wait', {
                reply_to_message_id: replyMessageId,
            });
        }
        catch (e) {
            console.error('Unable to send "photo received" message for ' + userId, e.toString());
        }
        console.log('Uploading to QQ for ' + userId);
        try {
            await ctx.reply('Uploading to QQ', {
                disable_web_page_preview: true,
                parse_mode: 'MarkdownV2',
            });
        }
        catch (e) {
            console.error('Unable to send Uploading for ' + userId, e.toString());
        }
        const urls = await qqRequest(response.data.toString('base64'));
        console.log('QQ responded successfully for ' + userId);
        console.log('Downloading from QQ for ' + userId);
        try {
            await ctx.reply('Downloading from QQ', {
                disable_web_page_preview: true,
                parse_mode: 'MarkdownV2',
            });
        }
        catch (e) {
            console.error('Unable to send Downloading from QQ for ' + userId, e.toString());
        }
        const [imgData, videoData] = await Promise.all([
            qqDownload(urls.img)
                .then((data) => cropImage(data)),
            ...((config_1.default.sendVideo ?? true) ? [qqDownload(urls.video)] : []),
        ]);
        if (config_1.default.keepFiles) {
            promises_1.default.writeFile(path_1.default.join(__dirname, 'files', (new Date()).getTime() + '_' + userId + '_output_img.jpg'), imgData);
        }
        let mediaSuccessfullySent = false;
        for (let retry = 0; retry < 100; retry++) {
            try {
                await ctx.replyWithMediaGroup([
                    {
                        type: 'photo',
                        media: {
                            source: imgData,
                        },
                        caption: config_1.default.botUsername,
                    },
                    ...((config_1.default.sendVideo ?? true) ? [{
                            type: 'video',
                            media: {
                                source: videoData,
                            },
                        }] : []),
                ], {
                    reply_to_message_id: replyMessageId,
                });
                mediaSuccessfullySent = true;
                break;
            }
            catch (e) {
                const msg = e.toString();
                console.error('Unable to send media for ' + userId, msg);
                if (msg.includes('replied message not found')) {
                    throw new Error('Photo has been deleted');
                }
                if (msg.includes('was blocked by the user')) {
                    break;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!mediaSuccessfullySent) {
            throw new Error('Unable to send media, please try again');
        }
        console.log('Files sent to ' + userId);
        if (config_1.default.byeMessage) {
            try {
                await ctx.reply(config_1.default.byeMessage, {
                    disable_web_page_preview: true,
                    parse_mode: 'MarkdownV2',
                });
            }
            catch (e) {
                console.error('Unable to send byeMessage for ' + userId, e.toString());
            }
        }
    }
    catch (e) {
        console.log('Error has occurred for ' + userId);
        console.error(e);
        for (let retry = 0; retry < 100; retry++) {
            try {
                await ctx.reply('Some nasty error has occurred, please try again\n\n' + e.toString());
                break;
            }
            catch (e) {
                const msg = e.toString();
                console.error('Unable to send error message for ' + userId, msg);
                if (msg.includes('was blocked by the user')) {
                    break;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    const currentSessionIndex = userSessions.findIndex((session) => session.userId === userId);
    userSessions.splice(currentSessionIndex, 1);
    console.log('Sessions length decreased: ' + userSessions.length);
    if (shuttingDown) {
        tryToShutDown();
    }
};
const addUserSession = async (ctx, userId, photoId, replyMessageId) => {
    const currentSession = (userSessions.find((session) => session.userId === userId));
    if (currentSession) {
        await ctx.reply('You are already in the queue, please wait', {
            reply_to_message_id: replyMessageId,
        });
        return;
    }
    const session = {
        ctx,
        userId,
        photoId,
        replyMessageId,
    };
    userSessions.push(session);
    console.log('Sessions length increased: ' + userSessions.length);
    await processUserSession(session);
};
let bot;
const startBot = () => {
    bot = new telegraf_1.Telegraf(config_1.default.botToken);
    const throttler = (0, telegraf_throttler_1.telegrafThrottler)();
    bot.use(throttler);
    bot.start((ctx) => {
        ctx.reply(config_1.default.helloMessage, {
            disable_web_page_preview: true,
            parse_mode: 'MarkdownV2',
        })
            .catch((e) => {
            console.error('Unable to send helloMessage for ' + ctx.update.message.from.id, e.toString());
        });
    });
    bot.on('photo', (ctx) => {
        const userId = ctx.update.message.from.id;
        console.log('Received photo from ' + userId);
        console.log(ctx.update.message.photo);
        const photoId = [...ctx.update.message.photo].pop()?.file_id || '';
        addUserSession(ctx, userId, photoId, ctx.update.message.message_id).catch(e => e);
    });
    bot.catch((e) => {
        console.error('Bot error has occurred ', e);
    });
    bot.launch();
};
const stopBot = () => {
    try {
        bot?.stop();
    }
    catch (e) {
        //
    }
};
let shuttingDown = false;
let tryToShutDown;
if (cluster_1.default.isPrimary) {
    let hasWorker = false;
    tryToShutDown = () => {
        shuttingDown = true;
        if (!hasWorker) {
            process.exit();
        }
    };
    const addWorker = () => {
        if (!shuttingDown) {
            const worker = cluster_1.default.fork();
            console.log(`Worker #${worker.process.pid} started`);
            hasWorker = true;
        }
    };
    addWorker();
    cluster_1.default.on('exit', (worker, code, signal) => {
        hasWorker = false;
        console.warn(`Worker #${worker.process.pid} is dead`, 'code:', code, 'signal:', signal);
        if (shuttingDown) {
            tryToShutDown();
        }
        else {
            setTimeout(() => {
                addWorker();
            }, 100);
        }
    });
}
else {
    startBot();
    tryToShutDown = () => {
        if (!shuttingDown) {
            stopBot();
        }
        shuttingDown = true;
        if (!userSessions.length) {
            process.exit();
        }
    };
}
process.on('SIGINT', () => tryToShutDown());
process.on('SIGTERM', () => tryToShutDown());
process.on('unhandledRejection', (promise, reason) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    tryToShutDown();
});
process.on('uncaughtException', (err, origin) => {
    console.error('Uncaught Exception:', err, 'origin:', origin);
    tryToShutDown();
});
