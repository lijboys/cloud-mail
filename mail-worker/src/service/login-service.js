import BizError from '../error/biz-error';
import userService from './user-service';
import emailUtils from '../utils/email-utils';
import { isDel, settingConst, userConst } from '../const/entity-const';
import JwtUtils from '../utils/jwt-utils';
import { v4 as uuidv4 } from 'uuid';
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import userContext from '../security/user-context';
import verifyUtils from '../utils/verify-utils';
import accountService from './account-service';
import settingService from './setting-service';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import turnstileService from './turnstile-service';
import roleService from './role-service';
import regKeyService from './reg-key-service';
import dayjs from 'dayjs';
import { formatDetailDate, toUtc } from '../utils/date-uitil';

const loginService = {

	async register(c, params) {

		const { email, password, token, code } = params;

		const {regKey, register} = await settingService.query(c)

		if (register === settingConst.register.CLOSE) {
			throw new BizError('注册功能已关闭');
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError('非法邮箱');
		}

		if (password.length > 30) {
			throw new BizError('密码长度超出限制');
		}

		if (emailUtils.getName(email).length > 30) {
			throw new BizError('邮箱长度超出限制');
		}

		if (password.length < 6) {
			throw new BizError('密码至少6位');
		}

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError('非法邮箱域名');
		}

		let type = null;
		let regKeyId = 0

		if (regKey === settingConst.regKey.OPEN) {
			const result = await this.handleOpenRegKey(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		if (regKey === settingConst.regKey.OPTIONAL) {
			const result = await this.handleOpenOptional(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		const accountRow = await accountService.selectByEmailIncludeDelNoCase(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError('该邮箱已被注销');
		}

		if (accountRow) {
			throw new BizError('该邮箱已被注册');
		}

		if (await settingService.isRegisterVerify(c)) {
			await turnstileService.verify(c,token)
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		let defType = null

		if (!type) {
			const roleRow = await roleService.selectDefaultRole(c);
			defType = roleRow.roleId
		}

		const userId = await userService.insert(c, { email, regKeyId,password: hash, salt, type: type || defType });

		await userService.updateUserInfo(c, userId, true);

		await accountService.insert(c, { userId: userId, email, name: emailUtils.getName(email) });

		if (regKey !== settingConst.regKey.CLOSE && type) {
			await regKeyService.reduceCount(c, code, 1);
		}

	},

	async handleOpenRegKey(c, regKey, code) {

		if (!code) {
			throw new BizError('注册码不能为空');
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			throw new BizError('注册码不存在');
		}

		if (regKeyRow.count <= 0) {
			throw new BizError('注册码使用次数已耗尽');
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day')
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (expireTime.isBefore(today)) {
			throw new BizError('注册码已过期');
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async handleOpenOptional(c, regKey, code) {

		if (!code) {
			return null
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			return null
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day')
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (regKeyRow.count <= 0 || expireTime.isBefore(today)) {
			return null
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async login(c, params) {

		const { email, password } = params;

		if (!email || !password) {
			throw new BizError('邮箱和密码不能为空');
		}

		const userRow = await userService.selectByEmailIncludeDel(c, email);

		if (!userRow) {
			throw new BizError('该用户不存在');
		}

		if(userRow.isDel === isDel.DELETE) {
			throw new BizError('该用户已被注销');
		}

		if(userRow.status === userConst.status.BAN) {
			throw new BizError('该用户已被禁用');
		}

		if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			throw new BizError('密码输入错误');
		}

		const uuid = uuidv4();
		const jwt = await JwtUtils.generateToken(c,{ userId: userRow.userId, token: uuid });

		let authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userRow.userId, { type: 'json' });

		if (authInfo) {

			if (authInfo.tokens.length > 10) {
				authInfo.tokens.shift();
			}

			authInfo.tokens.push(uuid);

		} else {

			authInfo = {
				tokens: [],
				user: userRow,
				refreshTime: dayjs().toISOString()
			};

			authInfo.tokens.push(uuid);

		}

		await userService.updateUserInfo(c, userRow.userId);

		await c.env.kv.put(KvConst.AUTH_INFO + userRow.userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		return jwt;
	},

	async logout(c, userId) {
		const token =userContext.getToken(c);
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		const index = authInfo.tokens.findIndex(item => item === token);
		authInfo.tokens.splice(index, 1);
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo));
	}

};

export default loginService;
